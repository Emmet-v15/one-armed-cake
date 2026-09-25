# one-armed-cake

**Game-grade latency on a slow DSL line, using a Raspberry Pi that sits *beside* the ISP router, not in front of it.**

The ISP router on most home connections cannot run modern queue management, so any bulk transfer fills its buffers and every game, call and web page behind it lags. This project turns a Raspberry Pi on one LAN port into a *one-armed* router. The Pi hands out itself as the gateway over DHCP, and shapes both directions with [CAKE](https://man7.org/linux/man-pages/man8/tc-cake.8.html). It comes with a live dashboard and a measurement toolkit. A [paper](paper/paper.pdf) covers what was learned along the way.

| 4 downloads saturating the line | median latency | p99 latency | throughput |
|---|---:|---:|---:|
| ISP router alone (profile `max`) | 165 ms | 229 ms | 4.3 Mbit/s |
| with the Pi (profile `gaming`) | **18 ms** | **26 ms** | 2.8 Mbit/s |

| 16 uploads starting at once | worst latency, first 1.5 s | probes lost |
|---|---:|---:|
| fair queueing alone | 97–132 ms | 13% |
| + game-packet classifier | **22–40 ms** | **0** |

*Game-style 50 Hz UDP probe to a reflector with 16 ms idle RTT; VDSL2 at ~5.9/2.0 Mbit/s. Ranges are min–max over repeated, interleaved trials. See [the paper](paper/paper.pdf) for method and limitations.*

## Features

- **One-armed CAKE shaping.** Both directions are shaped on egress after NAT, so per-host fairness works in both directions. This is the non-obvious part; see [architecture](docs/architecture.md).
- **Two profiles, switchable live.** `gaming` caps download below line rate so the queue stays in CAKE. `max` leaves download unshaped for full speed. Switching changes the rate in place, with no dropped connections.
- **Game-packet priority.** Small UDP packets (game inputs, voice chat) go to CAKE's Voice tin. This fixes a flow-start weakness of fair queueing on slow uplinks.
- **Live dashboard.** Throughput and latency at 20 Hz, a latency histogram, per-device rates with names (DHCP, NetBIOS, OUI vendor, DHCP OS fingerprint), and CAKE tin statistics. It has a profile switch and works on phones.
- **Honest latency measurement.** A game-style UDP echo to a reflector you control, not ICMP (often policed) or TCP handshakes (which turn one lost packet into a 1 s spike).
- **Reproducible experiments.** An interleaved-trial driver, a packet-capture analyser that localizes delay to a specific queue, raw data, and the scripts that produce every table and figure.

## How it works

```
Internet ── ISP router (modem, NAT, switch) ──┬── LAN hosts (gateway = Pi, via DHCP from the Pi)
                                              └── Raspberry Pi, eth0 only
                                                   eth0 egress ─┬─ dst in LAN → ifb-down: CAKE dual-dsthost ingress
                                                                └─ otherwise   → ifb-up:   CAKE dual-srchost nat ack-filter
```

Every forwarded packet enters and leaves the Pi on the same port. The ingress hook would see download traffic *before* NAT is reversed, when every packet is still addressed to the router, so both directions are classified on **egress** instead. On the upload side the source has already been masqueraded by then, which is why CAKE's `nat` option is required there. Details: [docs/architecture.md](docs/architecture.md).

## Repository layout

| path | contents |
|---|---|
| [`router/`](router/) | `router-shaper` script and config, systemd unit, nftables ruleset, dnsmasq, sysctl and journald settings |
| [`dashboard/`](dashboard/) | Bun server and single-page UI (`server.ts`, `index.html`), systemd unit |
| [`echo/`](echo/) | UDP echo reflector for the latency probe, systemd unit |
| [`tools/`](tools/) | `exp.py` experiment driver, `labsrv.py` load server, `capan.py` capture analyser, `analyze.py` tables and figures |
| [`data/`](data/) | raw per-trial results (JSON lines) and a data dictionary |
| [`paper/`](paper/) | LaTeX source and PDF |
| [`docs/`](docs/) | installation, configuration, dashboard, measurement, operations |

## Quick start

Requirements: a Linux box with one Ethernet port (tested on a Raspberry Pi 4B, Debian 13, kernel 6.18), `tc` with `sch_cake`, `nftables`, `dnsmasq`, and [Bun](https://bun.sh) for the dashboard.

```bash
sudo install -m755 router/router-shaper /usr/local/sbin/
sudo install -m644 router/router-shaper.conf.example /etc/router-shaper.conf   # then edit rates
sudo install -m644 router/router-shaper.service /etc/systemd/system/
sudo install -m644 router/nftables.conf /etc/nftables.conf
sudo systemctl enable --now nftables router-shaper
```

Then set up DHCP so clients use the Pi as their gateway, and **turn off the ISP router's DHCP server**. The full walkthrough, including the dashboard and the reflector, is in [docs/installation.md](docs/installation.md).

```bash
router-shaper status              # qdisc statistics for both directions
router-shaper profile gaming      # or: max
```

## Documentation

- [Installation](docs/installation.md): router, DHCP, dashboard, reflector
- [Architecture](docs/architecture.md): why egress, why `nat`, the classifier, the design decisions
- [Configuration](docs/configuration.md): every setting in `router-shaper.conf`, and how to pick rates
- [Dashboard](docs/dashboard.md): UI, HTTP/WebSocket API, latency probe, device naming
- [Measurement](docs/measurement.md): running the experiments, localizing delay, pitfalls
- [Operations](docs/operations.md): profiles, troubleshooting, recovery, SD-card wear
- [Paper](paper/paper.pdf): *Fair Queueing Is Not Enough at Flow Start* ([source](paper/paper.tex))

## Findings in brief

1. **Shape on egress, after NAT, and use `nat` on the upload side.** Without it, CAKE sees the whole LAN as one host.
2. **Fair queueing does not protect games while many flows start at once** on a slow uplink. A bounded priority tin for small UDP does.
3. **Receiver-side download shaping controls the steady state, not the first second** of a new download. That spike queues upstream, where no home router can reach it.
4. **Per-host fairness beats "prioritize my PC"**: demoting everyone else to the Bulk tin made latency worse, even for the favoured PC.
5. **Do not trust ping on a policed path.** An ICMP-driven autorate controller cost ~30% of throughput here and never detected bufferbloat.
6. **Validate your load generator.** One runtime on the test PC was silently throttled to ~0.45 Mbit/s, which looked exactly like catastrophic bufferbloat.

## Limitations

Results come from one line, one client and one reflector, measured over one day. The thresholds (download cap, UDP size limits) were tuned for this line; re-measure on yours with `tools/exp.py`. See the paper's limitations section.

## License

[MIT](LICENSE)
