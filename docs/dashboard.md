# Dashboard

A single Bun process (`dashboard/server.ts`) serving one page (`dashboard/index.html`) at `http://<box-address>/`. The page is responsive and works on phones.

## What it shows

- **Header:** connection state, uptime, load, CPU temperature (where the hardware reports one), memory, the **Gaming / Max throughput** switch, and badges (fairness mode, ack-filter, ICMP discard rate, interface errors).
- **Hero tiles:** latency (current, jitter, p95; coloured against a 50 ms budget), download and upload rate with peak and cap.
- **Stat strip:** CAKE queue delay per direction, CAKE drop rate, probe loss, wire rate on `WAN_IF` (in plus out, since every byte crosses twice), active devices, tracked connections.
- **Latency and throughput chart:** 30 s at 20 Hz on a shared time axis, latency on the left, Mbit/s on the right, with dashed shaper caps, a 50 ms line, and red ticks for lost probes.
- **Latency spread:** histogram with p50, p95 and p99 markers.
- **Devices:** sorted by current throughput (smoothed so rows don't jump), with live down/up rates, a bar showing the share of the line in use, a 60 s graph on a scale shared across devices, and 60 s peaks. Hover a row for its MAC, lease and data transferred. Hosts that don't answer ARP are folded into "stale addresses".
- **Queue and AQM:** per-direction shaped rate, queue delay, drops, ECN marks, ACKs thinned, flow counts, buffer use, and per-tin average/peak delay.

## Latency probe

| mode | target | rate | when |
|---|---|---|---|
| `udp` | `NETMON_ECHO_HOST:5201` (echo/echo-server.py) | 10/s | default when a reflector is configured |
| `tcp` | `1.1.1.1:443` handshake | 2.5/s | fallback after 5 s without echo replies, or no reflector set |

The probe is marked EF (nft output rule), so it measures what a marked game packet gets. The UDP mode reports loss as loss. The TCP fallback cannot: a lost SYN is retransmitted after the kernel's 1 s timeout, so a single loss shows up as a ~1020 ms sample.

ICMP ping is still run, but only to report how much ICMP the upstream discards. Some ISPs police ICMP heavily, so ping loss is not evidence of a line fault.

## Device names

For each host, in order of preference:

1. DHCP hostname from the lease file
2. NetBIOS name (`nmblookup -A`, with a 2 s timeout)
3. Hostname seen in dnsmasq's DHCP log (`log-dhcp`)
4. OUI vendor from the MAC (`/usr/share/ieee-data/oui.txt`)

The OS is guessed from the DHCP vendor-class and parameter-request fingerprint. Results are cached in `/var/lib/netmon/names.json`, refreshed every 60 s off the hot path. Devices using private (randomized) MACs have no vendor to look up.

## API

| method | path | description |
|---|---|---|
| `GET` | `/` | the page |
| `GET` | `/api/stats` | full snapshot as JSON, including the 30 s history |
| `GET` | `/ws` | WebSocket. The first message is a full snapshot with history. After that come 20 Hz tick arrays `[ts, downBps, upBps, latencyMs, icmpLossPct]` (latency `-1` = probe lost) and 1 Hz full snapshots without history. |
| `POST` | `/api/profile` | body `{"profile":"gaming"}` or `{"profile":"max"}`. Returns `{"ok":true,...}`, `400` for a bad value, `409` if a switch is already running. |

Selected snapshot fields: `download` / `upload` (CAKE stats per direction, including per-tin detail), `devices[]`, `probe {mode, target, intervalMs, lossPct}`, `profile`, `fairness`, `system`, `wire`, `conntrack`.

## Security

There is no login: anyone on the LAN can view the page and switch profiles, which is the intended trust model for a home network. Two guards stop a website from flipping the profile *through a LAN user's browser*:

- `/api/profile` only accepts `Content-Type: application/json`. A cross-site JSON POST needs a CORS preflight, which the server never grants.
- If an `Origin` header is present, it must match the host.

Bun's development error page is disabled, so errors never show source code or stack traces. Don't expose port 80 beyond the LAN.

## Environment

| variable | default | |
|---|---|---|
| `NETMON_ECHO_HOST` | *(empty)* | reflector hostname; empty means TCP probe only |
| `NETMON_ECHO_PORT` | `5201` | |
| `NETMON_PORT` | `80` | HTTP listen port |
| `NETMON_ROUTER_IP` | address of `WAN_IF` | the box's own address, excluded from the device list |
| `NETMON_WAN_IF` | `WAN_IF` from `/etc/router-shaper.conf` | interface for the wire counters |

Set these in a systemd drop-in (`/etc/systemd/system/netmon.service.d/*.conf`) so the unit file stays stock.
