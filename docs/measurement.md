# Measurement

Everything in the paper can be re-run with the tools in `tools/`.

## Setup

- A **reflector** you control: a server running `echo/echo-server.py` (UDP 5201) and, during experiments, `tools/labsrv.py` (TCP 5201, upload sink). Open both **to your home IP only**.
- A wired **client** on the LAN with Python 3 and curl.
- ssh access from the client to the router (`ROUTER_SSH`, key-based, passwordless `sudo` for `tc`, `nft` and `router-shaper`) and to the reflector (`REFLECTOR_SSH`).
- Copy `tools/labsrv.py` to `/tmp/labsrv.py` on the reflector.

```bash
export REFLECTOR=reflector.example.com ROUTER_SSH=router
python tools/exp.py upload   --reps 5      # 4 conditions: 4/16 uploads x marking off/on
python tools/exp.py download --reps 3      # 6 conditions: download cap sweep, 4 streams
python tools/analyze.py                    # tables -> paper/generated, figures -> paper/figures
```

The driver switches marking and caps on the router between conditions, and restores the configured profile when it finishes.

## Trial design

- **Probe:** 50 Hz UDP with a 64-byte payload (92-byte IP packet) and an 8-digit sequence number. Its size and rate resemble a game's input stream.
- **Timeline:** 2 s idle, then 8 s of load, then 2 s idle. Statistics are computed separately for idle, **start** (first 1.5 s of load) and **steady** (the rest of the load), because they behave differently.
- **Load:** upload is N TCP streams to `labsrv.py`. Download is N `curl` processes fetching a public 100 MB file.
- **Interleaving:** every repetition runs every condition in turn, so drift in line capacity is spread evenly instead of landing on whichever condition ran last.

## Localizing delay to a queue

On a one-armed router each packet crosses the interface four times, so a single capture separates the queues:

```bash
# on the router, while a trial runs
sudo tcpdump -i <WAN_IF> -tt -nn -e -A -l udp port 5201 > cap.txt
python3 tools/capan.py cap.txt --client <client-mac> --router <box-mac> --isp <isp-router-mac>
```

`capan.py` reports time in the upload qdisc, time beyond the router (ISP router, line, internet, reflector), and time in the download qdisc, plus where each lost packet disappeared. This is how the paper shows the flow-start losses happen inside CAKE rather than in the ISP router.

## Pitfalls we hit

| symptom | cause | what to do instead |
|---|---|---|
| 5–40% ping loss, "line fault" | ISP polices ICMP (TCP to the same host: 0% loss) | probe with UDP or TCP, never judge the line by ping |
| single ~1020 ms spikes | TCP-handshake probe: one lost SYN waits the kernel's 1 s retransmit timeout | UDP echo, count loss separately |
| 16–40 ms idle scatter | TCP handshakes to an anycast service | UDP echo to your own server (idle p95 16.9 ms) |
| multi-second "bufferbloat", 0.4 Mbit/s | the load generator was throttled on the client (python.exe only; curl/Bun fine) | cross-check the generator against an independent client |
| autorate pulls throughput down 30% | ICMP-based controller starved of replies (7,202 "reflector misbehaving" events per day) | static caps from a sweep, or a controller with a non-ICMP signal |
| `pkill -f script.py` over ssh kills itself | the remote shell's command line also matches | anchor the pattern: `pkill -f '^python3 /tmp/script.py'` |
| script fails with "No such file or directory" | CRLF line endings in the shebang | keep scripts LF (`.gitattributes` enforces it) |

## Web-based tests

Browser bufferbloat tests are a useful cross-check. On the reference line, one reported +173 ms under download and +7 ms under upload in `max`, matching `exp.py`. They cannot separate start from steady state, or show where the queue is.
