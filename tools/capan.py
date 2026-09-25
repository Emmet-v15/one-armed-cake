#!/usr/bin/env python3
"""Locate where probe packets are delayed or lost, from a router capture.

On a one-armed router each probe packet crosses the single interface four
times, so one capture separates the queues:

    A  client -> router       (arrives from the LAN)
    B  router -> ISP router   (leaves after the upload qdisc)
    C  ISP router -> router   (the reply arrives)
    D  router -> client       (leaves after the download qdisc)

    B - A = time in the upload qdisc      C - B = everything beyond the router
    D - C = time in the download qdisc

Packets are matched by the 8-digit sequence number that tools/exp.py puts at
the start of each probe payload; direction comes from the Ethernet MACs.

Capture on the router while a test runs, then analyse it there:

    sudo tcpdump -i eth0 -tt -nn -e -A -l udp port 5201 > cap.txt
    python3 capan.py cap.txt --client aa:.. --router bb:.. --isp cc:.. --load-start 2.0
"""
import argparse
import collections
import re

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("capture", help="tcpdump -tt -nn -e -A output")
ap.add_argument("--client", required=True, help="MAC of the test client")
ap.add_argument("--router", required=True, help="MAC of this router")
ap.add_argument("--isp", required=True, help="MAC of the ISP router / gateway")
ap.add_argument("--load-start", type=float, default=2.0, help="seconds from first probe to load start")
ap.add_argument("--start-window", type=float, default=1.5)
args = ap.parse_args()
PC, PI, HUB = args.client.lower(), args.router.lower(), args.isp.lower()
LEG = {(PC, PI): "A", (PI, HUB): "B", (HUB, PI): "C", (PI, PC): "D"}

hdr = re.compile(r"^(\d+\.\d+) ([0-9a-f:]{17}) > ([0-9a-f:]{17}),")
ev: dict = collections.defaultdict(dict)
cur, buf = None, ""


def flush() -> None:
    if cur:
        m = re.search(r"(\d{8})x", buf)
        if m:
            ev[int(m.group(1))].setdefault(cur[1], cur[0])


for line in open(args.capture):
    m = hdr.match(line)
    if m:
        flush()
        leg = LEG.get((m.group(2), m.group(3)))
        cur, buf = ((float(m.group(1)), leg) if leg else None), ""
    else:
        buf += line.strip()
flush()

t0 = min(e["A"] for e in ev.values() if "A" in e)


def fmt(v: list) -> str:
    return f"med {v[len(v) // 2]:5.1f} max {v[-1]:6.1f}" if v else " " * 20


def window(lo: float, hi: float, name: str) -> None:
    rows = [e for e in ev.values() if "A" in e and lo <= e["A"] - t0 < hi]
    up = sorted((e["B"] - e["A"]) * 1000 for e in rows if "B" in e)
    ext = sorted((e["C"] - e["B"]) * 1000 for e in rows if "B" in e and "C" in e)
    dn = sorted((e["D"] - e["C"]) * 1000 for e in rows if "C" in e and "D" in e)
    lost_up = sum(1 for e in rows if "B" not in e)
    lost_far = sum(1 for e in rows if "B" in e and "C" not in e)
    lost_dn = sum(1 for e in rows if "C" in e and "D" not in e)
    print(f"{name:<14} n={len(rows):4d} | upload qdisc {fmt(up)} | beyond router {fmt(ext)} | "
          f"download qdisc {fmt(dn)} ms | lost: upload qdisc {lost_up}, beyond {lost_far}, download qdisc {lost_dn}")


s = args.load_start
window(0, s, "idle")
window(s, s + args.start_window, "load start")
window(s + args.start_window, float("inf"), "load steady")
