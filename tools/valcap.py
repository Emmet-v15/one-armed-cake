#!/usr/bin/env python3
"""Find gaps and drops in Valorant's game traffic, from a valcap.ps1 run.

    python tools/valcap.py <run folder>

The run folder holds pc.pcapng (pktmon on the PC), and optionally pi.pcap
(tcpdump on the shaper's eth0) and ShooterGame.log (Valorant's own log).

Valorant's payloads are encrypted, so there are no sequence numbers to read.
Two things still work:

  gaps      The server sends at a steady tick, so a silence much longer than
            the usual interval means packets were lost or held up upstream.

  tracking  Every packet crosses the Pi's single port twice and NAT leaves the
            payload alone, so the same bytes can be found at each leg:
                up:   PC sent -> A (PC->Pi) -> B (Pi->hub)      missing at B: shaper drop
                down: C (hub->Pi) -> D (Pi->PC) -> PC received  missing at D: shaper drop
            Packets that never reach C were lost beyond the hub. That can only
            be estimated, from gaps at C; upload loss beyond the hub cannot be
            seen at all from inside the house.
"""
import collections
import datetime
import ipaddress
import os
import re
import socket
import statistics
import struct
import sys

GAME_PORTS = range(7000, 9000)
KEY_BYTES = 32                       # payload bytes used to recognise a packet across captures

Pkt = collections.namedtuple("Pkt", "ts smac dmac sip dip sport dport iplen key")


# ---------------------------------------------------------------- capture files

def frames(path):
    """Yield (ts, linktype, frame) from a pcap or pcapng file."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] == b"\x0a\x0d\x0d\x0a":
        yield from _pcapng(data)
    else:
        yield from _pcap(data)


def _pcap(data):
    for e in "<>":
        magic = struct.unpack(e + "I", data[:4])[0]
        if magic in (0xA1B2C3D4, 0xA1B23C4D):
            break
    else:
        raise ValueError("not a pcap file")
    frac = 1e-9 if magic == 0xA1B23C4D else 1e-6
    linktype = struct.unpack(e + "I", data[20:24])[0] & 0x0FFFFFFF
    off = 24
    while off + 16 <= len(data):
        sec, sub, incl, _ = struct.unpack(e + "IIII", data[off:off + 16])
        off += 16
        yield sec + sub * frac, linktype, data[off:off + incl]
        off += incl


def _pcapng(data):
    off, e, ifaces = 0, "<", []
    while off + 12 <= len(data):
        if data[off:off + 4] == b"\x0a\x0d\x0d\x0a":      # section header: sets byte order
            e = "<" if data[off + 8:off + 12] == b"\x4d\x3c\x2b\x1a" else ">"
            ifaces = []
        btype, blen = struct.unpack(e + "II", data[off:off + 8])
        if blen < 12:
            break
        body = data[off + 8:off + blen - 4]
        if btype == 1:                                     # interface description
            linktype, res, o = struct.unpack(e + "H", body[:2])[0], 1e-6, 8
            while o + 4 <= len(body):
                code, ln = struct.unpack(e + "HH", body[o:o + 4])
                if code == 0:
                    break
                if code == 9 and ln >= 1:                  # if_tsresol
                    v = body[o + 4]
                    res = 2.0 ** -(v & 0x7F) if v & 0x80 else 10.0 ** -v
                o += 4 + ((ln + 3) & ~3)
            ifaces.append((linktype, res))
        elif btype == 6:                                   # enhanced packet
            iid, th, tl, cap, _ = struct.unpack(e + "IIIII", body[:20])
            linktype, res = ifaces[iid]
            yield ((th << 32) | tl) * res, linktype, body[20:20 + cap]
        off += blen


def parse(ts, linktype, frame):
    smac = dmac = ""
    if linktype == 1:                                      # Ethernet
        if len(frame) < 14:
            return None
        dmac, smac = frame[0:6].hex(":"), frame[6:12].hex(":")
        et, o = struct.unpack("!H", frame[12:14])[0], 14
        while et in (0x8100, 0x88A8) and len(frame) >= o + 4:
            et, o = struct.unpack("!H", frame[o + 2:o + 4])[0], o + 4
        if et != 0x0800:
            return None
        ip = frame[o:]
    elif linktype in (101, 228):                           # raw IPv4
        ip = frame
    else:
        return None
    if len(ip) < 28 or ip[0] >> 4 != 4 or ip[9] != 17:
        return None
    if struct.unpack("!H", ip[6:8])[0] & 0x1FFF:           # later fragment, no UDP header
        return None
    ihl = (ip[0] & 15) * 4
    sport, dport = struct.unpack("!HH", ip[ihl:ihl + 4])
    iplen = struct.unpack("!H", ip[2:4])[0]
    key = iplen.to_bytes(2, "big") + ip[ihl + 8:ihl + 8 + KEY_BYTES]
    return Pkt(ts, smac, dmac, socket.inet_ntoa(ip[12:16]), socket.inet_ntoa(ip[16:20]),
               sport, dport, iplen, key)


def load(path):
    out = []
    for ts, lt, fr in frames(path):
        p = parse(ts, lt, fr)
        if p:
            out.append(p)
    out.sort(key=lambda p: p.ts)
    return out


def dedupe(pkts):
    """pktmon can log one packet at more than one NIC component; keep the first."""
    seen, out = {}, []
    for p in pkts:
        t = seen.get(p.key)
        if t is not None and p.ts - t < 0.005:
            continue
        seen[p.key] = p.ts
        out.append(p)
    return out


# ---------------------------------------------------------------- helpers

def private(ip):
    return ipaddress.ip_address(ip).is_private


def clock(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%H:%M:%S.%f")[:-3]


def pct(a, b):
    return 100.0 * a / b if b else 0.0


def quant(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else float("nan")


def gaps(times):
    """Silences much longer than the usual interval: (start, length, est. packets missing)."""
    if len(times) < 50:
        return 0.0, []
    d = [b - a for a, b in zip(times, times[1:])]
    med = statistics.median(d)
    thr = max(0.05, 6 * med)
    out = [(a, g, max(0, round(g / med) - 1)) for a, g in zip(times, d) if g > thr]
    return med, out


def find_flows(pkts):
    """Valorant game flows: a LAN host talking to a public host on a 7000-8999 port."""
    flows = collections.defaultdict(lambda: {"up": [], "down": []})
    for p in pkts:
        if private(p.sip) and not private(p.dip) and p.dport in GAME_PORTS:
            flows[(p.dip, p.dport, p.sip, p.sport)]["up"].append(p)
        elif private(p.dip) and not private(p.sip) and p.sport in GAME_PORTS:
            flows[(p.sip, p.sport, p.dip, p.dport)]["down"].append(p)
    keep = [(k, v) for k, v in flows.items() if len(v["up"]) >= 200 and len(v["down"]) >= 200]
    skipped = [(k, len(v["up"]), len(v["down"])) for k, v in flows.items()
               if (k, v) not in keep and len(v["up"]) + len(v["down"]) >= 50]
    return sorted(keep, key=lambda kv: kv[1]["up"][0].ts), skipped


def warnings(logpath):
    """Valorant's 'MaxUnacknowledgedInput... exceeded' warnings, as UTC epoch seconds."""
    if not os.path.exists(logpath):
        return []
    rx = re.compile(r"^\[(\d{4})\.(\d\d)\.(\d\d)-(\d\d)\.(\d\d)\.(\d\d):(\d{3})\].*MaxUnacknowledgedInput(\w+) exceeded")
    out = []
    with open(logpath, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = rx.match(line)
            if m:
                y, mo, d, h, mi, s, ms = map(int, m.groups()[:7])
                t = datetime.datetime(y, mo, d, h, mi, s, ms * 1000, tzinfo=datetime.timezone.utc)
                out.append((t.timestamp(), m.group(8)))
    return out


def overlaps(gs, t, before=1.5, after=0.2):
    """The gap (if any) that was in progress shortly before time t."""
    for a, g, n in gs:
        if a <= t + after and a + g >= t - before:
            return (a, g, n)
    return None


# ---------------------------------------------------------------- report

def report_flow(flow, f, warns, pi, pi_note, out):
    sip, sport, lip, lport = flow
    up, down = f["up"], f["down"]
    t0, t1 = min(up[0].ts, down[0].ts), max(up[-1].ts, down[-1].ts)
    dur = t1 - t0
    w = lambda s="": out.append(s)
    w("=" * 78)
    w(f"Game server {sip}:{sport}   local port {lport}   {clock(t0)} - {clock(t1)}  ({dur:.0f} s)")
    w("=" * 78)

    upt, dnt = [p.ts for p in up], [p.ts for p in down]
    umed, ugaps = gaps(upt)
    dmed, dgaps = gaps(dnt)
    w(f"{'':14}{'packets':>9}{'rate/s':>9}{'interval p50':>14}{'p99':>8}{'max':>8}{'gaps':>6}{'est. missing':>14}")
    for name, ts, med, gs in (("up (to srv)", upt, umed, ugaps), ("down (from)", dnt, dmed, dgaps)):
        d = [b - a for a, b in zip(ts, ts[1:])]
        miss = sum(n for _, _, n in gs)
        w(f"{name:14}{len(ts):>9}{len(ts) / dur:>9.1f}{med * 1000:>12.1f}ms{quant(d, .99) * 1000:>6.0f}ms"
          f"{max(d) * 1000:>6.0f}ms{len(gs):>6}{miss:>8} ({pct(miss, len(ts) + miss):.2f}%)")
    w("  gap = silence longer than max(50 ms, 6 x the usual interval). 'est. missing' assumes")
    w("  a steady send rate, so pauses the game makes on purpose (menus, alt-tab) count too.")
    w()

    w(f"Packet sizes: up p50 {quant([p.iplen for p in up], .5)} B, max {max(p.iplen for p in up)} B;"
      f" down p50 {quant([p.iplen for p in down], .5)} B, max {max(p.iplen for p in down)} B")
    w()

    allgaps = sorted([("down", *g) for g in dgaps] + [("up", *g) for g in ugaps], key=lambda g: -g[2])
    if allgaps:
        w("Longest gaps at the PC:")
        for d, a, g, n in allgaps[:12]:
            w(f"  {clock(a)}  {d:4}  {g * 1000:6.0f} ms  ~{n} packets")
        w()

    # Pi side: where in the house did packets go missing?
    pigaps_pc = []
    if pi is None:
        w(f"Shaper capture: {pi_note}")
        w()
    else:
        mine = [p for p in pi if (p.dip == sip and p.dport == sport) or (p.sip == sip and p.sport == sport)]
        pc_mac = collections.Counter(p.smac for p in up).most_common(1)[0][0]
        pi_mac = collections.Counter(p.dmac for p in up).most_common(1)[0][0]
        legs = {"A": [], "B": [], "C": [], "D": []}
        for p in mine:
            if p.dip == sip and p.smac == pc_mac:
                legs["A"].append(p)
            elif p.dip == sip and p.smac == pi_mac:
                legs["B"].append(p)
            elif p.sip == sip and p.dmac == pi_mac and p.smac != pc_mac:
                legs["C"].append(p)
            elif p.sip == sip and p.smac == pi_mac and p.dmac == pc_mac:
                legs["D"].append(p)
        idx = {k: {p.key: p.ts for p in v} for k, v in legs.items()}
        if not legs["A"] or not legs["C"]:
            w(f"Shaper capture: no packets for this flow (legs A/B/C/D: "
              f"{'/'.join(str(len(v)) for v in legs.values())}); was it running during this match?")
            w()
        else:
            offs = [p.ts - idx["A"][p.key] for p in up if p.key in idx["A"]]
            off = statistics.median(offs) if offs else 0.0
            lo, hi = min(p.ts for p in mine) + 1.0, max(p.ts for p in mine) - 1.0
            sent = [p for p in up if lo <= p.ts - off <= hi]
            atA = [p for p in sent if p.key in idx["A"]]
            atB = [p for p in atA if p.key in idx["B"]]
            arrC = [p for p in legs["C"] if lo <= p.ts <= hi]
            atD = [p for p in arrC if p.key in idx["D"]]
            pcdown = {p.key for p in down}
            atPC = [p for p in atD if p.key in pcdown]
            qup = [(idx["B"][p.key] - idx["A"][p.key]) * 1000 for p in atB]
            qdn = [(idx["D"][p.key] - p.ts) * 1000 for p in atD]
            cmed, cgaps = gaps([p.ts for p in legs["C"]])
            cmiss = sum(n for _, _, n in cgaps)
            pigaps_pc = [(a + off, g, n) for a, g, n in cgaps]

            w(f"Through the house (shaper capture, {hi - lo:.0f} s overlap; Pi clock offset {off * 1000:+.0f} ms):")
            w(f"  up    PC sent {len(sent):>6}   reached Pi (A) {len(atA):>6}   left Pi (B) {len(atB):>6}")
            w(f"        lost PC->Pi {len(sent) - len(atA):>4} ({pct(len(sent) - len(atA), len(sent)):.2f}%)"
              f"   dropped by shaper {len(atA) - len(atB):>4} ({pct(len(atA) - len(atB), len(atA)):.2f}%)")
            w(f"  down  reached Pi (C) {len(arrC):>6}   left Pi (D) {len(atD):>6}   reached PC {len(atPC):>6}")
            w(f"        dropped by shaper {len(arrC) - len(atD):>4} ({pct(len(arrC) - len(atD), len(arrC)):.2f}%)"
              f"   lost Pi->PC {len(atD) - len(atPC):>4} ({pct(len(atD) - len(atPC), len(atD)):.2f}%)")
            if qup and qdn:
                w(f"  time in shaper: up p50 {quant(qup, .5):.2f} p99 {quant(qup, .99):.2f} max {max(qup):.1f} ms;"
                  f" down p50 {quant(qdn, .5):.2f} p99 {quant(qdn, .99):.2f} max {max(qdn):.1f} ms")
            w(f"  beyond the hub, download: {len(cgaps)} gaps at the Pi, ~{cmiss} packets missing"
              f" ({pct(cmiss, len(legs['C']) + cmiss):.2f}%) before they reached the house")
            w("  (upload loss beyond the hub is invisible from here)")
            note = re.search(r"(\d+) packets? dropped by kernel", pi_note or "")
            if note and int(note.group(1)):
                w(f"  WARNING: tcpdump itself dropped {note.group(1)} packets; shaper-drop counts may be inflated")
            w()

    ws = [(t, k) for t, k in warns if t0 <= t <= t1]
    if ws:
        dn = sum(1 for t, _ in ws if overlaps(dgaps, t))
        upc = sum(1 for t, _ in ws if overlaps(ugaps, t))
        beyond = sum(1 for t, _ in ws if overlaps(pigaps_pc, t))
        none = sum(1 for t, _ in ws if not (overlaps(dgaps, t) or overlaps(ugaps, t)))
        w(f"Valorant input warnings during this flow: {len(ws)}")
        w(f"  right after a download gap at the PC: {dn}   after an upload gap: {upc}   neither: {none}")
        if pi is not None and pigaps_pc:
            w(f"  of those, download gap already present when packets reached the Pi: {beyond}")
        w("  'neither' means the PC kept sending and receiving normally, so the server lost or")
        w("  ignored inputs after they left: upload loss beyond the hub, or the server itself.")
        for t, k in ws[:25]:
            g = overlaps(dgaps, t) or overlaps(ugaps, t)
            gd = f"gap {g[1] * 1000:.0f} ms at {clock(g[0])}" if g else "no gap"
            w(f"    {clock(t)}  {k:10}  {gd}")
        if len(ws) > 25:
            w(f"    ... {len(ws) - 25} more")
        w()


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    run = sys.argv[1]
    pc_path = os.path.join(run, "pc.pcapng")
    if not os.path.exists(pc_path):
        sys.exit(f"no pc.pcapng in {run}")
    pc = dedupe(load(pc_path))
    flows, skipped = find_flows(pc)
    out = [f"valcap report for {run}", ""]
    if not flows:
        out.append("No Valorant game flow found (UDP to a public 7000-8999 port with 200+ packets each way).")
        for (sip, sport, _, _), nu, nd in skipped:
            out.append(f"  skipped {sip}:{sport}: {nu} up, {nd} down -- too little traffic for live play")
        out.append("Was a round being played while the capture ran? Menus and end-of-match screens send far less.")
        print("\n".join(out))
        return

    pi, pi_note = None, "not captured"
    pi_path = os.path.join(run, "pi.pcap")
    note_path = os.path.join(run, "pi-tcpdump.txt")
    if os.path.exists(note_path):
        with open(note_path, encoding="utf-8", errors="replace") as f:
            pi_note = f.read().strip() or pi_note
    if os.path.exists(pi_path) and os.path.getsize(pi_path) > 24:
        pi = load(pi_path)

    warns = warnings(os.path.join(run, "ShooterGame.log"))
    for flow, f in flows:
        report_flow(flow, f, warns, pi, pi_note, out)
    print("\n".join(out))


if __name__ == "__main__":
    main()
