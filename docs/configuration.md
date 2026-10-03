# Configuration

`router-shaper` reads `/etc/router-shaper.conf`, a bash fragment of `KEY=value` lines. [`router/router-shaper.conf.example`](../router/router-shaper.conf.example) is a documented starting point.

## Reference

| key | example | meaning |
|---|---|---|
| `PROFILE` | `gaming` | `gaming` caps download at `DL_RATE`; `max` leaves it unshaped. Written by `router-shaper profile`. |
| `MAX_UNSHAPE_UPLOAD` | `no` | In `max`, also remove the upload cap. |
| `DL_RATE` | `4500kbit` | Download cap in `gaming` (wire rate, including overhead). |
| `UL_RATE` | `1800kbit` | Upload cap, both profiles. |
| `RTT` | `100ms` | CAKE `rtt`, which sets CoDel's interval. Upload always; download in `max`. |
| `GAMING_RTT` | `30ms` | Download `rtt` in `gaming`. |
| `OVERHEAD` | `overhead 34 mpu 68 ptm` | CAKE link-layer compensation. |
| `ACK` | `yes` | Enable `ack-filter` on upload. |
| `WAN_IF` | `eth0` | The single interface. The installer sets it from the default route. The dashboard reads it from here too. |
| `LAN_SUBNET` | `192.168.1.0/24` | Used by the tc filters and the classifier. |
| `FAIRNESS` | `fair` | `fair` or `priority`. Written by `router-shaper fairness`. |
| `PRIORITY_HOST` | `192.168.1.100` | Only used with `FAIRNESS=priority`. |
| `GAME_PRIORITY` | `yes` | Mark small UDP EF (Voice tin). |

## Choosing rates

**Upload.** Set `UL_RATE` about 10% below the upstream sync rate from your modem's status page. Upload is usually the easier direction: the box is the sender's first hop, so shaping there is exact.

**Download.** Shaping download at the receiving end only works if the cap is below what the line actually delivers, and DSL capacity drifts. Measure rather than guess:

1. Set `PROFILE=gaming` and run `tools/exp.py download` (see [measurement](measurement.md)).
2. Find the knee: the highest cap where **steady p99** stays low. On the reference line, 5300 kbit/s behaved like no cap (p99 219 ms), 5100 was bimodal, and 4800 was controlled.
3. Back off about 10% for drift. The reference line uses 4500 kbit/s: steady median 18 ms, p99 26 ms.

Going further below the knee does not improve latency; it only costs throughput.

**Overhead.** VDSL2 uses PTM framing: `overhead 34 mpu 68 ptm` is a common starting point for IPoE-over-VDSL2. ADSL uses ATM (`atm` plus overhead for your encapsulation). Getting this wrong mostly shows up as an effective rate a few percent off.

## What it cannot fix

- **The first second of a new download.** A new download's slow-start burst queues at the DSLAM before the box sees it. On the reference line that was a p99 of about 120 ms for about 1.5 s, even in `gaming`. Only ISP-side queue management or paced senders fix this.
- **Traffic that bypasses the box**: devices with static gateway settings, or IPv6 if the ISP router advertises it (the box does not route IPv6).
- **Wi-Fi airtime contention** on the ISP router's access point.

## Commands

```
router-shaper start | stop | restart     build or tear down qdiscs and classifier
router-shaper down                       stop, then also remove NAT/forwarding (no longer a router)
router-shaper status                     per-direction CAKE statistics
router-shaper show                       one-line summary of the config
router-shaper profile gaming | max       switch live (tc qdisc change)
router-shaper fairness fair | priority   rewrite the forward-chain rules
```
