// Local network monitor for the one-armed CAKE shaper.
//
// Two cadences, so the graph streams smoothly without hammering the box:
//   FAST (20Hz)  byte counters straight from sysfs + a persistent ping process.
//                No subprocess per sample. Pushed as a compact array.
//   SLOW (1Hz)   tc/nft/lease parsing, which does cost subprocesses.
//                Pushed as {type:"full"}.
//
// History is sent ONCE, to seed a newly connected client. Broadcasting it every
// second would mean re-stringifying ~3600 numbers per second for no reason.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { lookup } from "dns/promises";
import { networkInterfaces } from "os";

const TC = "/usr/sbin/tc";
const NFT = "/usr/sbin/nft";
const LEASES = "/var/lib/misc/dnsmasq.leases";
const TIN_NAMES = ["Bulk", "Best Effort", "Video", "Voice"];
const PING_TARGET = "1.1.1.1";
const PROBE_HOST = "1.1.1.1";
const PROBE_PORT = 443;
const PROBE_MS = 400;    // 2.5 handshakes/sec — modest, and it is the real number
// Primary probe: game-style UDP to an echo server you run (echo/echo-server.py).
// A TCP handshake turns one lost packet into a ~1020 ms sample (the kernel's 1 s
// SYN retransmit), and handshakes to 1.1.1.1 scatter 16-40 ms even when idle;
// the UDP echo measured 16.1 ms median / 16.9 p95 idle and reports loss as loss.
// Firewall it so only your own public IP can reach it. EF is set by an nft output
// rule on udp dport 5201, so it measures the Voice tin like a marked game packet.
// Falls back to the TCP probe if the echo stops answering, or if none is set.
const ECHO_HOST = process.env.NETMON_ECHO_HOST ?? "";   // re-resolved every 60 s
const ECHO_PORT = Number(process.env.NETMON_ECHO_PORT ?? 5201);
const ECHO_MS = 100;     // 10/sec, ~1 kB/s each way
const ECHO_TIMEOUT = 1000;
const CONF = "/etc/router-shaper.conf";

// Read straight from the shaper config rather than hardcoding. The dashboard used
// to hardcode 192.168.1.128 as "priority", so it kept labelling that host
// prioritised long after we switched to a fair split — reporting a policy that
// was not in effect.
function confValue(key: string, fallback: string): string {
  try {
    const m = readFileSync(CONF, "utf8").match(new RegExp(`^${key}=(\\S+)`, "m"));
    return m ? m[1].replace(/^["']|["']$/g, "") : fallback;
  } catch { return fallback; }
}

// Network layout comes from the shaper config too, so the dashboard runs on any
// box the shaper does. The router's own address is read off the interface.
const WAN_IF = process.env.NETMON_WAN_IF ?? confValue("WAN_IF", "eth0");
const LAN_SUBNET = confValue("LAN_SUBNET", "192.168.1.0/24");
const ROUTER_IP = process.env.NETMON_ROUTER_IP ??
  networkInterfaces()[WAN_IF]?.find((a) => a.family === "IPv4")?.address ?? "";
const ipNum = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
function inLan(ip: string): boolean {
  const [net, bits] = LAN_SUBNET.split("/");
  const size = 2 ** (32 - Number(bits ?? 32));
  return Math.floor(ipNum(ip) / size) === Math.floor(ipNum(net) / size);
}

function currentFairness(): string {
  try {
    const m = readFileSync(CONF, "utf8").match(/^FAIRNESS=(\w+)/m);
    return m && ["fair", "priority"].includes(m[1]) ? m[1] : "fair";
  } catch { return "fair"; }
}

const FAST_MS = 50;      // 20 samples/sec
// 5 pings/sec. Do NOT raise this to 10/sec: Cloudflare rate-limits ICMP at that
// cadence and the graph fills with timeouts that look like line faults but aren't.
const PING_INTERVAL = "0.2";
const HISTORY = 600;     // 30s at 20Hz — kept near the chart's pixel width so the
                         // client never has to decimate (decimation caused flicker)

async function sh(cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    return await new Response(p.stdout).text();
  } catch {
    return "";
  }
}

function lines(p: string): string[] {
  try {
    return readFileSync(p, "utf8").split("\n").filter((x) => x.trim().length > 0);
  } catch {
    return [];
  }
}

// ---------- fast path: sysfs counters, no process spawn ----------
function txBytes(dev: string): number {
  try {
    return Number(readFileSync(`/sys/class/net/${dev}/statistics/tx_bytes`, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

const prev: Record<string, { bytes: number; t: number }> = {};
function rate(key: string, bytes: number): number {
  const now = Date.now();
  const p = prev[key];
  prev[key] = { bytes, t: now };
  if (!p || now <= p.t) return 0;
  const bps = ((bytes - p.bytes) * 8000) / (now - p.t);
  return bps > 0 && Number.isFinite(bps) ? bps : 0;
}

const history = { up: [] as number[], down: [] as number[], lat: [] as number[] };
// The cards need a live rate, but tc's qdisc dump only carries cumulative bytes.
// Carry the newest fast-path sample across so the two agree with the graph.
let lastDownBps = 0, lastUpBps = 0;
const devHistory = new Map<string, { d: number[]; u: number[] }>();
let lastLatency = -1;
let snapshot: any = null;   // broadcast every 1s, no history
let server: any = null;

function push(arr: number[], v: number) {
  arr.push(v);
  if (arr.length > HISTORY) arr.shift();
}

// ---------- latency: TCP handshake in the Voice tin, not ICMP ----------
// Measured 2026-09-08: to 1.1.1.1, under load, ICMP echo lost 38% while TCP
// handshakes to the same address succeeded 40/40. The upstream polices ICMP, so
// a ping-based graph reports timeouts that real traffic never experiences.
//
// The probe is also DSCP EF-marked, by an nft rule in `table ip one_armed_cake` chain
// output matching 1.1.1.1:443. That puts it in CAKE's Voice tin, so the graph
// reports the latency a properly marked realtime app (game, VoIP) actually gets
// rather than what unmarked bulk traffic sees. Keep the port at 443 or the nft
// rule stops matching and the number silently becomes a Best Effort measurement.
// Every 400ms forever, so a socket leaked per probe exhausts the fd limit and
// kills the server within hours. The timeout path is the dangerous one: it used
// to resolve without closing, and a connection that completed *after* we gave up
// was then never closed at all. Track the socket and close it on every exit path.
function tcpProbe(): Promise<number> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    let sock: any = null;
    const shut = () => { try { sock?.end(); } catch {} };
    const finish = (v: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      shut();
      resolve(v);
    };
    const timer = setTimeout(() => finish(-1), 2000);
    Bun.connect({
      hostname: PROBE_HOST,
      port: PROBE_PORT,
      socket: {
        open(s) { sock = s; finish(performance.now() - t0); },
        error() { finish(-1); },
        data() {}, close() {},
      },
    }).then((s) => {
      sock = s;
      if (settled) shut();   // connected after the timeout already fired
    }).catch(() => finish(-1));
  });
}

let probeMode: "udp" | "tcp" = "udp";
let lastEchoReply = Date.now();   // 5 s grace at startup before falling back
// Loss is kept per probe type: while the UDP reflector is unreachable its window
// is all misses, and reporting that during TCP fallback shows 100% loss on a
// path that is working.
const udpWindow: boolean[] = [];        // last 600 UDP probes, true = answered
const tcpWindow: boolean[] = [];        // last 150 TCP probes (1 min at 400 ms)
function noteWindow(w: boolean[], ok: boolean, max: number) {
  w.push(ok);
  if (w.length > max) w.shift();
}
function noteProbe(ok: boolean) {
  noteWindow(udpWindow, ok, 600);
}

async function echoLoop() {
  if (!ECHO_HOST) { probeMode = "tcp"; return; }   // no reflector configured
  let addr = "";
  let resolvedAt = 0;
  const pending = new Map<number, number>();   // seq -> send time
  let newestReply = -1;
  const sock = await Bun.udpSocket({
    socket: {
      data(_s, buf) {
        const seq = Number(new TextDecoder().decode(buf.subarray(0, 8)));
        const t = pending.get(seq);
        if (t === undefined) return;          // late reply already counted lost
        pending.delete(seq);
        noteProbe(true);
        lastEchoReply = Date.now();
        if (seq > newestReply) {
          newestReply = seq;
          if (probeMode === "udp") lastLatency = performance.now() - t;
        }
      },
    },
  });
  const pad = new Uint8Array(56).fill(120);
  for (let seq = 0; ; seq++) {
    try {
      if (!addr || Date.now() - resolvedAt > 60000) {
        addr = (await lookup(ECHO_HOST, { family: 4 })).address; resolvedAt = Date.now();
      }
      const msg = new Uint8Array(64);
      msg.set(new TextEncoder().encode(String(seq).padStart(8, "0"))); msg.set(pad, 8);
      pending.set(seq, performance.now());
      sock.send(msg, ECHO_PORT, addr);
    } catch { addr = ""; }
    // expire probes older than the timeout; a gap only shows on the graph when
    // nothing newer has come back either, i.e. the path is dropping right now
    const now = performance.now();
    for (const [q, t] of pending) {
      if (now - t < ECHO_TIMEOUT) break;
      pending.delete(q); noteProbe(false);
      if (q > newestReply && probeMode === "udp") lastLatency = -1;
    }
    // fall back to TCP after 5 s of silence, return as soon as a reply arrives
    if (probeMode === "udp" && Date.now() - lastEchoReply > 5000) probeMode = "tcp";
    else if (probeMode === "tcp" && Date.now() - lastEchoReply < 1000) probeMode = "udp";
    await Bun.sleep(ECHO_MS);
  }
}

async function latencyLoop() {
  for (;;) {
    if (probeMode === "tcp") {
      try { lastLatency = await tcpProbe(); }
      catch { lastLatency = -1; }
      noteWindow(tcpWindow, lastLatency >= 0, 150);
    }
    await Bun.sleep(PROBE_MS);
  }
}

// ICMP is still tracked, but only to report how much of it is being discarded —
// it is a property of the upstream, not of the user's throughput.
const icmpWindow: boolean[] = [];
let icmpLoss = 0;

async function icmpLossLoop() {
  for (;;) {
    try {
      const p = Bun.spawn(["ping", "-i", PING_INTERVAL, "-O", PING_TARGET], {
        stdout: "pipe", stderr: "ignore",
      });
      const reader = p.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (/time=[\d.]+\s*ms/.test(line)) icmpWindow.push(true);
          else if (/no answer|Unreachable|timeout/i.test(line)) icmpWindow.push(false);
          else continue;
          if (icmpWindow.length > 120) icmpWindow.shift();
          const bad = icmpWindow.reduce((a, ok) => a + (ok ? 0 : 1), 0);
          icmpLoss = Math.round((bad / icmpWindow.length) * 100);
        }
      }
    } catch {}
    await Bun.sleep(1000); // ping died; restart
  }
}

// Compact wire format for the hot path: [ts, down, up, lat].
// An object with keys costs ~3x the bytes and more parse time at 20Hz.
function fastTick() {
  const down = Math.round(rate("ifb-down", txBytes("ifb-down")));
  const up = Math.round(rate("ifb-up", txBytes("ifb-up")));
  lastDownBps = down; lastUpBps = up;
  push(history.down, down);
  push(history.up, up);
  push(history.lat, lastLatency);
  server?.publish("stats", `[${Date.now()},${down},${up},${lastLatency.toFixed(1)},${icmpLoss}]`);
}

// ---------- slow path ----------
async function cake(dev: string) {
  const out = await sh([TC, "-s", "-j", "qdisc", "show", "dev", dev]);
  if (!out) return null;
  let q: any;
  try {
    q = JSON.parse(out)[0];
  } catch {
    return null;
  }
  if (!q) return null;
  // options.bandwidth is absent entirely when the qdisc is `unlimited`, which is
  // the normal state under PROFILE=max -- so 0 here means "no cap", not "broken".
  const bw = q.options?.bandwidth;
  const shapedBps = typeof bw === "number" ? bw * 8 : 0;
  const pkts = q.packets ?? 0;
  const drops = q.drops ?? 0;
  const backlogBytes = q.backlog ?? 0;
  // A queue is only meaningful as time. Bytes tell you nothing without the
  // drain rate; milliseconds are what the user actually feels.
  const drainBps = shapedBps || (q.capacity_estimate ?? 0) * 8 || 0;
  return {
    shapedBps,
    unlimited: typeof bw !== "number",
    capacityBps: (q.capacity_estimate ?? 0) * 8,
    bytes: q.bytes ?? 0,
    packets: pkts,
    drops,
    dropPct: pkts + drops > 0 ? (drops / (pkts + drops)) * 100 : 0,
    backlog: backlogBytes,
    backlogMs: drainBps > 0 ? (backlogBytes * 8 / drainBps) * 1000 : 0,
    memUsed: q.memory_used ?? 0,
    memLimit: q.memory_limit ?? 0,
    overhead: q.options?.overhead ?? 0,
    framing: q.options?.atm ?? "",
    flowmode: q.options?.flowmode ?? "",
    rttMs: (q.options?.rtt ?? 0) / 1000,
    ackFilter: !!q.options?.["ack-filter"],
    tins: (q.tins ?? []).map((t: any, i: number) => ({
      name: TIN_NAMES[i] ?? `Tin ${i}`,
      bytes: t.sent_bytes ?? 0,
      packets: t.sent_packets ?? 0,
      drops: t.drops ?? 0,
      ecnMark: t.ecn_mark ?? 0,
      ackDrops: t.ack_drops ?? 0,
      backlogBytes: t.backlog_bytes ?? 0,
      sparseFlows: t.sparse_flows ?? 0,
      bulkFlows: t.bulk_flows ?? 0,
      unresponsiveFlows: t.unresponsive_flows ?? 0,
      baseDelayMs: (t.base_delay_us ?? 0) / 1000,
      avgDelayMs: (t.avg_delay_us ?? 0) / 1000,
      peakDelayMs: (t.peak_delay_us ?? 0) / 1000,
      targetMs: (t.target_us ?? 0) / 1000,
      thresholdBps: (t.threshold_rate ?? 0) * 8,
    })),
  };
}

// ---------- device naming ----------
// dnsmasq only knows a hostname if the client sent option 12. For the ones that
// do not, fall back to NetBIOS then to the MAC's OUI vendor. Resolution is slow
// and the answers never change, so it is cached on disk.
const NAME_CACHE = "/var/lib/netmon/names.json";
let nameCache: Record<string, { name?: string; vendor?: string; via?: string; os?: string; t: number }> = {};
try { nameCache = JSON.parse(readFileSync(NAME_CACHE, "utf8")); } catch {}
let nameCacheDirty = false;

// A MAC with bit 1 of the first octet set is locally administered, i.e. a
// randomised privacy MAC. There is no vendor to look up and never will be, so
// say so rather than showing a blank column.
function isRandomMac(mac: string): boolean {
  const first = parseInt(mac.split(":")[0] ?? "0", 16);
  return Number.isFinite(first) && (first & 0x02) !== 0;
}

let ouiTable: Map<string, string> | null = null;
function ouiLookup(mac: string): string {
  if (!mac || isRandomMac(mac)) return "";
  if (!ouiTable) {
    ouiTable = new Map();
    try {
      // Format: "00000C     (base 16)\t\tCisco Systems, Inc"
      for (const l of readFileSync("/usr/share/ieee-data/oui.txt", "utf8").split("\n")) {
        const m = l.match(/^([0-9A-F]{6})\s+\(base 16\)\s+(.+?)\s*$/);
        if (m) ouiTable.set(m[1], m[2]);
      }
    } catch {}
  }
  const key = mac.replace(/:/g, "").slice(0, 6).toUpperCase();
  return ouiTable.get(key) ?? "";
}

// nmblookup blocks for its full timeout against anything that is not a
// Windows/Samba host, which is most of the LAN. Hard-cap it, and never call it
// from slowTick -- doing so stalled the whole snapshot.
async function netbiosName(ip: string): Promise<string> {
  const out = await sh(["/usr/bin/timeout", "2", "/usr/bin/nmblookup", "-A", ip]);
  // "\tHOSTNAME        <00> -         B <ACTIVE>" ; skip group entries <GROUP>
  for (const l of out.split("\n")) {
    const m = l.match(/^\s+(\S+)\s+<00>\s+-\s+/);
    if (m && !/GROUP/.test(l)) return m[1];
  }
  return "";
}

// dnsmasq's log-dhcp already records each client's DHCP vendor class, which
// identifies the OS even when the MAC is randomised and no hostname is sent --
// the one case OUI lookup can never help with. dnsmasq logs the vendor class and
// the MAC on separate lines sharing a transaction id, so correlate on that.
async function dhcpFingerprints(): Promise<Record<string, { os?: string; provided?: string }>> {
  const out = await sh([
    "/usr/bin/journalctl", "-u", "dnsmasq", "--no-pager", "-o", "cat", "-n", "4000",
  ]);
  const byXid: Record<string, { os?: string; provided?: string; mac?: string }> = {};
  for (const l of out.split("\n")) {
    const m = l.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const e = (byXid[m[1]] ??= {});
    const rest = m[2];
    let g;
    if ((g = rest.match(/vendor class:\s*(.+?)\s*$/))) e.os = g[1];
    else if ((g = rest.match(/client provides name:\s*(.+?)\s*$/))) e.provided = g[1];
    else if ((g = rest.match(/DHCP\w+\(\S+\)\s+\S+\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i))) e.mac = g[1].toLowerCase();
  }
  const byMac: Record<string, { os?: string; provided?: string }> = {};
  for (const e of Object.values(byXid)) {
    if (!e.mac) continue;
    const t = (byMac[e.mac] ??= {});
    if (e.os) t.os = e.os;
    if (e.provided) t.provided = e.provided;
  }
  return byMac;
}

// "android-dhcp-16" is accurate but ugly; show it as a version.
function prettyOs(v?: string): string {
  if (!v) return "";
  const a = v.match(/^android-dhcp-(\d+)/i);
  if (a) return `Android ${a[1]}`;
  if (/^MSFT/i.test(v)) return "Windows";
  if (/dhcpcd/i.test(v)) return "Linux";
  if (/udhcp/i.test(v)) return "embedded Linux";
  return v.length > 24 ? v.slice(0, 24) : v;
}

// Decorating a device from the cache is synchronous and cheap; only the actual
// lookups are slow, and those run in their own loop below.
function decorateName(d: any) {
  const c = nameCache[d.mac || d.ip];
  d.vendor = c?.vendor ?? ouiLookup(d.mac);
  d.os = c?.os ?? "";
  if (!d.named && c?.name) { d.name = c.name; d.via = c.via ?? "cache"; }
}

async function nameResolverLoop() {
  for (;;) {
    try {
      const rows: [string, string, string, string][] =
        lines(LEASES).map((l) => l.split(/\s+/) as any);
      // Also resolve hosts that only appear in ARP (no DHCP lease), or they stay
      // permanently nameless.
      const arp = arpTable();
      const haveIp = new Set(rows.map((r) => r[2]));
      for (const [ip, a] of Object.entries(arp)) {
        if (a.mac && !haveIp.has(ip) && inLan(ip)) rows.push(["0", a.mac, ip, "*"]);
      }
      const fp = await dhcpFingerprints();
      for (const [, mac, ip, host] of rows) {
        const key = mac || ip;
        const c = nameCache[key];
        if (c && Date.now() - c.t < 24 * 3600 * 1000) continue;
        const vendor = ouiLookup(mac);
        const os = prettyOs(fp[mac?.toLowerCase()]?.os);
        let name = "", via = "";
        if (!host || host === "*") {
          const nb = await netbiosName(ip);
          if (nb) { name = nb; via = "netbios"; }
          // A DHCP name the client gave on an earlier lease still identifies it.
          else if (fp[mac?.toLowerCase()]?.provided) { name = fp[mac.toLowerCase()].provided!; via = "dhcp-log"; }
          else if (vendor) { name = vendor; via = "vendor"; }
          else if (os) { name = os + " device"; via = "fingerprint"; }
        }
        nameCache[key] = { name, vendor, via, os, t: Date.now() };
        nameCacheDirty = true;
      }
      if (nameCacheDirty) {
        nameCacheDirty = false;
        try {
          mkdirSync("/var/lib/netmon", { recursive: true });
          writeFileSync(NAME_CACHE, JSON.stringify(nameCache));
        } catch {}
      }
    } catch {}
    await Bun.sleep(60000);
  }
}

async function nftSet(name: string) {
  const out = await sh([NFT, "-j", "list", "set", "ip", "one_armed_cake", name]);
  const m: Record<string, { bytes: number }> = {};
  if (!out) return m;
  try {
    const s = JSON.parse(out).nftables.find((x: any) => x.set)?.set;
    for (const e of s?.elem ?? []) {
      const v = e.elem ?? e;
      m[v.val] = { bytes: v.counter?.bytes ?? 0 };
    }
  } catch {}
  return m;
}

// Devices that show up in the accounting sets but hold no DHCP lease had no MAC
// at all, so no vendor could be derived for them. The kernel's ARP table has it,
// and it is a plain file — no subprocess.
// Only entries with ATF_COM (flags & 0x2) carry a resolved MAC. Flags 0x0 means
// INCOMPLETE: the kernel tried to resolve the address and got no answer, so the
// host is not currently on the LAN and any MAC shown is stale. Reading those was
// producing phantom devices that appeared to share a MAC with each other.
function arpTable(): Record<string, { mac: string; present: boolean }> {
  const m: Record<string, { mac: string; present: boolean }> = {};
  for (const l of lines("/proc/net/arp").slice(1)) {
    const f = l.trim().split(/\s+/);
    if (!f[0] || !f[3]) continue;
    const flags = parseInt(f[2], 16);
    const complete = Number.isFinite(flags) && (flags & 0x2) !== 0;
    if (f[3] === "00:00:00:00:00:00") continue;
    // Keep the MAC even when INCOMPLETE -- it is the last known good address, so
    // it still identifies the vendor. Only `present` reflects whether the host
    // actually answered, and that is reported separately rather than by
    // pretending we do not know who it was.
    m[f[0]] = { mac: f[3], present: complete };
  }
  return m;
}

// Default gateway, from the routing table, so the Hub can be labelled as such
// instead of appearing as an anonymous host.
function defaultGateway(): string {
  for (const l of lines("/proc/net/route").slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f[1] === "00000000" && f[2] && f[2] !== "00000000") {
      const h = f[2];
      return [6, 4, 2, 0].map((i) => parseInt(h.substr(i, 2), 16)).join(".");
    }
  }
  return "";
}

function nread(p: string): number {
  try { return Number(readFileSync(p, "utf8").trim()) || 0; } catch { return 0; }
}

// WAN_IF carries BOTH directions on a one-armed router, so its counters are the
// "wire" truth. Comparing wire bytes against what ifb-down actually delivered is
// how the cake-autorate throttling was caught -- surface it permanently.
function wire() {
  const s = (f: string) => nread(`/sys/class/net/${WAN_IF}/statistics/${f}`);
  return {
    rxBps: rate("eth0rx", s("rx_bytes")),
    txBps: rate("eth0tx", s("tx_bytes")),
    rxErrors: s("rx_errors"), txErrors: s("tx_errors"),
    rxDropped: s("rx_dropped"), txDropped: s("tx_dropped"),
  };
}

function conntrack() {
  return {
    count: nread("/proc/sys/net/netfilter/nf_conntrack_count"),
    max: nread("/proc/sys/net/netfilter/nf_conntrack_max"),
  };
}

function system() {
  const up = lines("/proc/uptime")[0]?.split(" ")[0] ?? "0";
  const load = lines("/proc/loadavg")[0]?.split(" ").slice(0, 3) ?? [];
  const temp = lines("/sys/class/thermal/thermal_zone0/temp")[0];   // absent on many PCs and VMs
  const mem = lines("/proc/meminfo");
  const kv = (k: string) => Number(mem.find((l) => l.startsWith(k))?.replace(/\D+/g, "") ?? 0);
  const total = kv("MemTotal"), avail = kv("MemAvailable");
  return {
    uptimeSec: Number(up),
    load,
    tempC: temp ? Number(temp) / 1000 : null,
    memUsedPct: total ? Math.round(((total - avail) / total) * 100) : 0,
  };
}

async function slowTick() {
  const [up, down, sUp, sDown] = await Promise.all([
    cake("ifb-up"), cake("ifb-down"), nftSet("up"), nftSet("down"),
  ]);

  if (down) (down as any).currentBps = lastDownBps;
  if (up) (up as any).currentBps = lastUpBps;

  const ips = new Set([...Object.keys(sUp), ...Object.keys(sDown)]);
  const usage = new Map([...ips].map((ip) => [ip, {
    ip,
    upBytes: sUp[ip]?.bytes ?? 0,
    downBytes: sDown[ip]?.bytes ?? 0,
    upBps: rate("u:" + ip, sUp[ip]?.bytes ?? 0),
    downBps: rate("d:" + ip, sDown[ip]?.bytes ?? 0),
  }]));

  const zero = { upBytes: 0, downBytes: 0, upBps: 0, downBps: 0 };
  const devices: any[] = lines(LEASES).map((l) => {
    const [expiry, mac, ip, name] = l.split(/\s+/);
    const known = !!name && name !== "*";
    return {
      mac, ip,
      name: known ? name : ip,
      named: known,             // did the client actually tell us its hostname?
      via: known ? "dhcp" : "",
      randomMac: isRandomMac(mac),
      expiry: Number(expiry), ...(usage.get(ip) ?? zero),
    };
  });
  const arp = arpTable();
  const gw = defaultGateway();
  const seen = new Set(devices.map((d) => d.ip));
  for (const [ip, u] of usage) {
    if (!seen.has(ip) && ip !== ROUTER_IP) {
      const a = arp[ip];
      const mac = a?.mac ?? "";
      devices.push({
        mac, ip, name: ip, named: false, via: "", randomMac: mac ? isRandomMac(mac) : false,
        present: !!a?.present, expiry: 0, noLease: true, ...u,
      });
    }
  }
  for (const d of devices) {
    if (d.present === undefined) d.present = !!arp[d.ip]?.present;
    if (!d.mac && arp[d.ip]?.mac) { d.mac = arp[d.ip].mac; d.randomMac = isRandomMac(d.mac); }
    decorateName(d);
    if (d.ip === gw) { d.name = d.named ? d.name : (d.vendor || "gateway"); d.via = "gateway"; d.isGateway = true; }
  }
  // Same MAC on two addresses is one device with a stale lease/ARP entry, not two
  // devices — worth showing rather than silently double-counting it.
  const macCount: Record<string, number> = {};
  for (const d of devices) if (d.mac) macCount[d.mac] = (macCount[d.mac] ?? 0) + 1;
  for (const d of devices) d.dupMac = d.mac ? macCount[d.mac] > 1 : false;

  // Short per-device history so the table can carry sparklines. Keyed by IP and
  // trimmed to devices we still see, so a churning DHCP range cannot grow it.
  for (const d of devices) {
    const h = devHistory.get(d.ip) ?? { d: [], u: [] };
    h.d.push(Math.round(d.downBps)); h.u.push(Math.round(d.upBps));
    if (h.d.length > 60) { h.d.shift(); h.u.shift(); }
    devHistory.set(d.ip, h);
    d.sparkD = h.d; d.sparkU = h.u;
  }
  for (const ip of [...devHistory.keys()]) if (!devices.some((d) => d.ip === ip)) devHistory.delete(ip);

  devices.sort((a, b) => b.downBytes + b.upBytes - (a.downBytes + a.upBytes));

  // No "wire vs delivered" loss figure: on a one-armed router WAN_IF rx carries
  // both WAN->box download and LAN->box upload, so the ratio measures the
  // traffic mix, not loss. CAKE's own drop counters are the real number.
  const w = wire();
  const probeWin = probeMode === "udp" ? udpWindow : tcpWindow;

  snapshot = {
    type: "full", ts: Date.now(),
    upload: up, download: down,
    devices, system: system(), fastMs: FAST_MS,
    wire: w, conntrack: conntrack(),
    probe: {
      mode: probeMode,
      target: probeMode === "udp" ? `${ECHO_HOST}:${ECHO_PORT} UDP` : `${PROBE_HOST}:${PROBE_PORT} TCP`,
      intervalMs: probeMode === "udp" ? ECHO_MS : PROBE_MS,
      lossPct: probeWin.length ? (probeWin.filter((x) => !x).length / probeWin.length) * 100 : 0,
      samples: probeWin.length,
    },
    icmpLoss,
    fairness: currentFairness(),
    profile: confValue("PROFILE", "gaming") === "max" ? "max" : "gaming",
    priorityHost: confValue("PRIORITY_HOST", ""),
  };
  server?.publish("stats", JSON.stringify(snapshot));
}

// Switch between the two shaper profiles from the dashboard. Anyone on the LAN
// can already reach this page, so there is no login, but two guards stop a
// random website from flipping it through the user's browser: the body must be
// JSON (a cross-site JSON POST needs a CORS preflight, which we never grant),
// and the Origin, if present, must be this host.
let switching = false;
async function setProfile(req: Request, url: URL): Promise<Response> {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) return new Response("bad origin", { status: 403 });
  if (!(req.headers.get("content-type") ?? "").includes("application/json"))
    return new Response("json only", { status: 415 });
  let want = "";
  try { want = String((await req.json())?.profile ?? ""); } catch {}
  if (want !== "max" && want !== "gaming") return new Response("profile must be max or gaming", { status: 400 });
  if (switching) return new Response("busy", { status: 409 });
  switching = true;
  try {
    const p = Bun.spawn(["/usr/local/sbin/router-shaper", "profile", want], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) return Response.json({ ok: false, error: (err || out).trim() }, { status: 500 });
    return Response.json({ ok: true, profile: want });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  } finally { switching = false; }
}

const HTML = await Bun.file(new URL("./index.html", import.meta.url)).text();

server = Bun.serve({
  // Port 80: the unit runs as root, so no privileged-port problem, and the
  // dashboard is reachable at http://<router-address>/ with no port to remember.
  port: Number(process.env.NETMON_PORT ?? 80),
  hostname: "0.0.0.0",
  // Never serve Bun's development error page: it shows source and stack to
  // anyone on the LAN.
  development: false,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/api/stats") return Response.json(snapshot ? { ...snapshot, history } : {});
    if (url.pathname === "/api/profile" && req.method === "POST") return setProfile(req, url);
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  websocket: {
    // perMessageDeflate off: these frames are tiny and already compact, so
    // compressing 20x/sec would cost more CPU than it saves bandwidth.
    perMessageDeflate: false,
    open(ws: any) {
      ws.subscribe("stats");
      if (snapshot) ws.send(JSON.stringify({ ...snapshot, history })); // seed once
    },
    close(ws: any) { ws.unsubscribe("stats"); },
    message() {},
  },
});

// A monitor that dies is worse than one reporting a stale number, so a stray
// error anywhere must not take the process down. systemd restarts it if it does,
// but a restart loses the history buffer and drops every connected browser.
process.on("uncaughtException", (e) => console.error("uncaught:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

latencyLoop();
echoLoop();
icmpLossLoop();
nameResolverLoop();
setInterval(fastTick, FAST_MS);
setInterval(() => { slowTick().catch((e) => console.error("slowTick:", e)); }, 1000);
slowTick().catch((e) => console.error("slowTick:", e));

console.log(`netmon on http://0.0.0.0:3000  (ws /ws, fast ${FAST_MS}ms, slow 1000ms)`);
