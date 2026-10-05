# one-armed-cake

[![CI](https://github.com/Emmet-v15/one-armed-cake/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Emmet-v15/one-armed-cake/actions/workflows/ci.yml)

**Game-grade latency on a slow DSL line, using a small Linux box (a Raspberry Pi, an old laptop, a VM) that sits *beside* the ISP router, not in front of it.**

> **In 30 seconds**
>
> - **Problem:** on a ~5.9/2.0 Mbit/s VDSL2 line, any bulk transfer filled the ISP router's buffers. Under a 4-stream download a game-style probe saw a median of 165 ms (p99 229 ms). The ISP router could not be replaced or reprogrammed.
> - **Result:** with the shaper, the same load gave a median of **18 ms** (p99 **26 ms**), at the cost of throughput (2.8 vs 4.3 Mbit/s). When 16 uploads started at once, a small-UDP classifier took the worst-case probe from 97–132 ms with 13% loss (49/375) to **22–40 ms with no loss**.
> - **How:** a Linux box on one LAN port becomes every device's gateway over DHCP and shapes both directions with CAKE on *egress, after NAT*, which is what makes per-device fairness work through a single port. Includes an installer, a live dashboard, an experiment driver, the raw data and a [paper](paper/paper.pdf).
> - **Limitations:** one line, one day. One VDSL2 line, one client, one reflector, measured over one day; rates and thresholds were tuned for that line.
> - **Authorship:** design, measurement and verification by Emmet; implementation (code, docs, paper text) AI-assisted with Claude ([details](#authorship)).
> - **Stack:** Linux `tc`/CAKE, nftables, Bash, systemd, TypeScript on Bun, Python, LaTeX.

The ISP router on most home connections cannot run modern queue management, so any bulk transfer fills its buffers and every game, call and web page behind it lags. This project turns any Linux machine on one LAN port into a *one-armed* router: no second network port, and no change to the ISP router beyond turning off its DHCP server. The box hands out itself as the gateway over DHCP, and shapes both directions with [CAKE](https://man7.org/linux/man-pages/man8/tc-cake.8.html). It comes with a live dashboard and a measurement toolkit. A [paper](paper/paper.pdf) covers what was learned along the way.

| 4 downloads saturating the line | median latency | p99 latency | throughput |
|---|---:|---:|---:|
| ISP router alone (profile `max`) | 165 ms | 229 ms | 4.3 Mbit/s |
| with the shaper (profile `gaming`) | **18 ms** | **26 ms** | 2.8 Mbit/s |

| 16 uploads starting at once | worst latency, first 1.5 s | probes lost |
|---|---:|---:|
| fair queueing alone | 97–132 ms | 13% |
| + game-packet classifier | **22–40 ms** | **0** |

*Game-style 50 Hz UDP probe to a reflector with 15.9 ms median idle RTT; VDSL2 at ~5.9/2.0 Mbit/s. Ranges are min–max over repeated, interleaved trials. See [the paper](paper/paper.pdf) for method and limitations.*

## Features

- **One-armed CAKE shaping.** Both directions are shaped on egress after NAT, so per-host fairness works in both directions. This is the non-obvious part; see [architecture](docs/architecture.md).
- **Two profiles, switchable live.** `gaming` caps download below line rate so the queue stays in CAKE. `max` leaves download unshaped for full speed. Switching changes the rate in place, with no dropped connections.
- **Game-packet priority.** Small UDP packets (game inputs, voice chat) go to CAKE's Voice tin. This fixes a flow-start weakness of fair queueing on slow uplinks.
- **Live dashboard.** Throughput and latency at 20 Hz, a latency histogram, per-device rates with names (DHCP, NetBIOS, OUI vendor, DHCP OS fingerprint), and CAKE tin statistics. It has a profile switch and works on phones.
- **Honest latency measurement.** A game-style UDP echo to a reflector you control, not ICMP (often policed) or TCP handshakes (which turn one lost packet into a 1 s spike).
- **Reproducible experiments.** An interleaved-trial driver, a packet-capture analyser that localizes delay to a specific queue, raw data, and the scripts that produce every table and figure.

## How it works

```
Internet ── ISP router (modem, NAT, switch) ──┬── LAN hosts (gateway = the box, via DHCP from the box)
                                              └── Linux box, one port (WAN_IF, e.g. eth0)
                                                   WAN_IF egress ─┬─ dst in LAN → ifb-down: CAKE dual-dsthost ingress
                                                                  └─ otherwise   → ifb-up:   CAKE dual-srchost nat ack-filter
```

Every forwarded packet enters and leaves the box on the same port. The ingress hook would see download traffic *before* NAT is reversed, when every packet is still addressed to the router, so both directions are classified on **egress** instead. On the upload side the source has already been masqueraded by then, which is why CAKE's `nat` option is required there. Details: [docs/architecture.md](docs/architecture.md).

## Repository layout

| path | contents |
|---|---|
| [`install.sh`](install.sh) | installer: detects the network, checks the kernel, installs and starts everything |
| [`router/`](router/) | `router-shaper` script and config, systemd unit, dnsmasq template, sysctl and journald settings |
| [`dashboard/`](dashboard/) | Bun server and single-page UI (`server.ts`, `index.html`), systemd unit |
| [`echo/`](echo/) | UDP echo reflector for the latency probe, systemd unit |
| [`relay/`](relay/) | optional public read-only view: reverse-tunnel unit for the router, fan-out relay for a server |
| [`tools/`](tools/) | `exp.py` experiment driver, `labsrv.py` load server, `capan.py` capture analyser, `analyze.py` tables and figures |
| [`data/`](data/) | raw per-trial results (JSON lines) and a data dictionary |
| [`paper/`](paper/) | LaTeX source and PDF |
| [`docs/`](docs/) | installation, configuration, dashboard, measurement, operations |

## Quick start

You need an always-on Linux machine with a **wired** connection to the ISP router: a Raspberry Pi, an old laptop, a mini PC, a home server, or a VM with bridged networking. It must run a Debian-family distribution (Raspberry Pi OS, Debian, Ubuntu) with a kernel that includes CAKE (mainline since 4.19; WSL's kernel does not), and [Bun](https://bun.sh) for the dashboard. The shaper keeps its firewall rules in its own nftables table, so it coexists with Docker or an existing host firewall. Tested on a Raspberry Pi 4B running Debian 13.

```bash
git clone https://github.com/Emmet-v15/one-armed-cake && cd one-armed-cake
sudo ./install.sh --dry-run --down 45mbit --up 9mbit    # see what it would do
sudo ./install.sh --down 45mbit --up 9mbit              # ~90% of a speed test; 85% on DSL
```

That installs and starts the shaper and dashboard, but changes nothing for other devices yet. Try it on one device by setting that device's gateway to the box's address by hand. When it works, rerun with `--dhcp` so every device uses it, and **turn off the ISP router's DHCP server**. `sudo ./install.sh --uninstall` reverses it. Details, manual steps and Windows options: [docs/installation.md](docs/installation.md).

```bash
router-shaper status              # qdisc statistics for both directions
router-shaper profile gaming      # or: max
```

## Documentation

- [Installation](docs/installation.md): hardware, the installer, trying it on one device, DHCP, the reflector, Windows options
- [Architecture](docs/architecture.md): why egress, why `nat`, the classifier, the design decisions
- [Configuration](docs/configuration.md): every setting in `router-shaper.conf`, and how to pick rates
- [Dashboard](docs/dashboard.md): UI, HTTP/WebSocket API, latency probe, device naming
- [Measurement](docs/measurement.md): running the experiments, localizing delay, pitfalls
- [Operations](docs/operations.md): profiles, troubleshooting, recovery, SD-card wear
- [Public view](docs/public.md): publishing a read-only, anonymized dashboard on your own domain
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

## Authorship

- **Design, measurement and verification:** Emmet. The measurements were taken on the testbed described in the paper.
- **Implementation:** AI-assisted. The shaper script, installer, dashboard, experiment and analysis tools, these docs and the paper's prose were written with the assistance of an AI coding assistant (Claude, Anthropic), as the paper's acknowledgment also states.

## Development

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the checks that exist; there is no unit-test suite. It syntax-checks the shell scripts and runs ShellCheck at error severity, byte-compiles the Python tools, bundles the dashboard with Bun to catch TypeScript syntax errors, and regenerates `paper/generated/` from `data/` with `tools/analyze.py`, failing if any committed table or number differs. To build the paper locally: `cd paper && latexmk -pdf paper.tex`.

## License

[MIT](LICENSE)
