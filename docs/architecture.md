# Architecture

## Topology

```
Internet ── ISP router ──┬── LAN hosts          default gateway = Pi (DHCP from the Pi)
            (modem, NAT, └── Raspberry Pi       one Ethernet port: eth0
             switch)
```

The Pi is not physically between the LAN and the internet. It is another host on the LAN that the other hosts use as their gateway. Every forwarded packet therefore enters and leaves on the same port. That is what "one-armed" means. The Pi masquerades towards the ISP router, which NATs again to the internet (double NAT, which is harmless for typical use).

## Why shape on egress, in both directions

The usual way to shape download on Linux is to redirect *ingress* traffic to an IFB device. On a one-armed NAT router that fails for per-host fairness:

- **tc ingress runs before conntrack reverses NAT.** Every inbound download packet is still addressed to the Pi itself. CAKE cannot tell which LAN host it is for, so `dual-dsthost` sees a single host.
- **On eth0 egress towards the LAN, NAT has been undone.** The destination is the real host.

So both directions are classified on eth0 **egress**:

```
eth0 root: prio (bands 3), filters:
  1. src in LAN and dst in LAN   -> pass (router's own LAN chatter, unshaped)
  2. dst in LAN                  -> mirred redirect to ifb-down   (download)
  3. everything else             -> mirred redirect to ifb-up     (upload)
```

`ifb-down` runs `cake ... dual-dsthost ingress`, and `ifb-up` runs `cake ... dual-srchost nat wash ack-filter`.

## Why `nat` on the upload side

tc egress runs **after** the netfilter POSTROUTING hook, so by the time an upload packet reaches `ifb-up`, masquerade has already rewritten its source to the Pi's address. We verified this by counting in a postrouting chain at priority 200: 7,600 packets from the router's address, zero from the real host. Without `nat`, `dual-srchost` sees one host for the whole LAN and isolates nothing. With `nat`, CAKE looks up the pre-NAT source in conntrack.

Download does not need `nat`: inbound NAT is reversed in PREROUTING, long before egress.

## The two profiles

| | download | upload | download `rtt` |
|---|---|---|---|
| `gaming` | `bandwidth $DL_RATE` | `bandwidth $UL_RATE` | `$GAMING_RTT` (30 ms) |
| `max` | `unlimited` | `bandwidth $UL_RATE` | `$RTT` (100 ms) |

In `max`, CAKE still runs on download (flow isolation and statistics) but is never the bottleneck, so under load the queue forms in the DSLAM's buffer. Upload stays capped in both profiles. On an asymmetric line, upload saturation causes the worst bufferbloat, and lifting the cap gains only the last ~10% of the sync rate.

`router-shaper profile X` switches with `tc qdisc change`, which changes only the rate and `rtt` on the running qdiscs. Queued packets, counters and every other option are kept, so a game running during the switch sees no hitch. A cold start (`router-shaper start`, or boot) builds everything from the config.

## Game-packet classifier

Fair queueing normally gives a sparse flow, such as a game's small packets, near-zero queueing delay, because new and sparse flows are served first. That breaks down when **many bulk flows start at the same time**: each one is also "new", and on a slow uplink each quantum takes milliseconds to send. With 16 uploads starting at 1.8 Mbit/s, a game-style probe saw up to 132 ms and 13% loss in the first 1.5 s, all inside CAKE (paper, Tables 1–2).

`GAME_PRIORITY=yes` adds two rules to `table ip mangle chain forward`, where real hosts are visible in both directions:

```
ip saddr $LAN meta l4proto udp ip length <= 300                    ip dscp set ef   # upload
ip daddr $LAN udp sport != 443 ip length <= 1000                    ip dscp set ef   # download
```

EF maps to CAKE's Voice tin in `diffserv4`, which is served first up to 25% of the link. Past that threshold it loses priority rather than starving others, which bounds the damage of a false match. TCP never matches, and port 443 is excluded on download to keep QUIC data out. `wash` on the upload qdisc clears the mark before it leaves the house.

## Fairness modes

`FAIRNESS=fair` (the default) gives each host an equal share, and each host's flows share fairly among themselves. `FAIRNESS=priority` keeps `PRIORITY_HOST` in Best Effort and marks everyone else CS1 into the Bulk tin. That mode exists only for comparison. It measured worse for *every* host, including the favoured one: the Bulk tin's long AQM target (161 ms up at these rates) lets demoted traffic build a standing queue in the shared bottleneck.

## Dashboard data paths

| cadence | source | cost |
|---|---|---|
| 20 Hz | `/sys/class/net/ifb-*/statistics/tx_bytes` | file reads, no subprocess |
| 10 Hz | UDP echo probe (or TCP fallback at 2.5 Hz) | one datagram |
| 1 Hz | `tc -s qdisc`, `nft` sets, leases, `/proc/net/arp`, conntrack | a few subprocesses |
| 60 s | device-name resolver (NetBIOS, dnsmasq journal) | background, cached |

High-rate samples go out as compact arrays over a WebSocket. The 30 s history is sent once, when a client connects, rather than every second.
