# Installation

## What you need

- **An always-on Linux machine with a wired connection** to a LAN port of the ISP router. It only needs one network port. Any of these work:
  - a Raspberry Pi (the reference box is a Pi 4B)
  - an old laptop or mini PC
  - a home server that already runs other things (the shaper keeps its firewall rules in its own table and leaves the rest alone)
  - a virtual machine with **bridged** networking, so it appears on the LAN as its own device: a Hyper-V external switch, a VirtualBox bridged adapter, or a Proxmox bridge

  Wi-Fi works in principle, but every forwarded packet crosses the link twice, so use Ethernet. WSL and Docker Desktop do not work: their networking is NAT'd behind the host, and WSL's kernel has no CAKE.
- **A Debian-family distribution** (Raspberry Pi OS, Debian, Ubuntu) with systemd. Other distributions work with the [manual steps](#manual-installation).
- **A kernel with CAKE.** It is in mainline Linux since 4.19, and every current Debian, Ubuntu and Raspberry Pi OS kernel ships it. To check: `sudo modprobe sch_cake && echo ok`.
- **Your line's real speed.** Run a speed test with nothing else busy. You will pass about 90% of each direction to the installer (85% on DSL, whose overhead is higher).
- **[Bun](https://bun.sh)**, for the dashboard. Its installer puts it in `~/.bun/bin`; `install.sh` finds it there and copies it to `/usr/local/bin`.
- **Access to the ISP router's admin page**, to turn its DHCP server off at the end and back on if you ever remove the box.

## 1. Run the installer

```bash
git clone https://github.com/Emmet-v15/one-armed-cake && cd one-armed-cake
sudo ./install.sh --dry-run --down 45mbit --up 9mbit    # print every step, change nothing
sudo ./install.sh --down 45mbit --up 9mbit
```

It works out the interface, the box's address, the LAN subnet and the ISP router's address from the default route, then:

1. refuses to continue if the kernel lacks `sch_cake` or `ifb`
2. installs `iproute2` and `nftables` (plus `ieee-data` and `samba-common-bin` for device naming on the dashboard)
3. installs `router-shaper`, and writes `/etc/router-shaper.conf` with your interface, subnet and rates. An existing config is never overwritten.
4. starts the shaper. It turns on forwarding and creates `table ip one_armed_cake` (NAT, game-packet marking and per-device byte counters). It does not touch any other nftables table.
5. on an SD card, moves the journal to RAM and stops the daily man-db rebuild ([why](operations.md#sd-card-wear)). Force this with `--low-writes` or skip it with `--no-low-writes`.
6. installs and starts the dashboard on port 80, or 8080 if something else already has port 80

| option | effect |
|---|---|
| `--down RATE --up RATE` | line rates, e.g. `45mbit`, `4500kbit`. Required on first install. |
| `--dhcp` | also serve DHCP, making the box every device's gateway. See [step 3](#3-whole-house-dhcp). |
| `--iface IF` | use this interface instead of the one with the default route |
| `--port N` | dashboard port |
| `--no-dashboard` | shaper only |
| `--dry-run` | print what would happen |
| `--uninstall` | stop and remove everything except the config |

**VDSL2 is the default framing.** For cable, fibre or ADSL, change `OVERHEAD` in `/etc/router-shaper.conf` (see [configuration](configuration.md)), then run `sudo systemctl restart router-shaper`.

Give the box a **static address**, or a DHCP reservation in the ISP router, before relying on it. The installer warns if the address came from DHCP, and `--dhcp` refuses outright, because the box is about to become the DHCP server.

## 2. Try it on one device

At this point nothing has changed for the rest of the network. Pick one device and, in its network settings, keep its address but set the **gateway** (Windows: "default gateway"; macOS and iOS: "router") to the box's address. Then:

- open the dashboard (`http://<box-address>/`): the device should appear with live rates
- run a latency-under-load test such as Waveform's bufferbloat test, and compare it with the same test with the gateway pointed back at the ISP router
- `tracert` / `traceroute` from the device should show the box as the first hop

If the device loses internet, set its gateway back. Nothing else is affected.

## 3. Whole house: DHCP

```bash
sudo ./install.sh --dhcp
```

This writes `/etc/dnsmasq.d/one-armed-cake.conf` from [`router/dnsmasq-router.conf.in`](../router/dnsmasq-router.conf.in). It hands out `.20` to `.250` of the subnet, with the box as gateway and DNS, on 12-hour leases.

Then **turn off the ISP router's DHCP server**. If both answer, clients take whichever replies first, and some keep the ISP router as their gateway, so their traffic never touches the box. To check for two answers, run this from another Linux host (the box itself cannot see its own reply):

```bash
sudo nmap --script broadcast-dhcp-discover -e <interface>
```

Clients move over when the leases they hold from the ISP router come up for renewal. Rebooting the ISP router makes Wi-Fi clients reconnect at once.

> From here on the box is the whole house's gateway. If it goes down, clients lose internet until you turn the ISP router's DHCP back on. See [recovery](operations.md#recovery).

## 4. Tune the rates

The rates you passed are a starting point. [Configuration](configuration.md#choosing-rates) explains how to find the highest download cap that still keeps latency flat, and `tools/exp.py` automates the sweep.

## 5. Optional but recommended: a latency reflector

The dashboard measures latency best against a UDP echo that you run on a server near your ISP's network, such as a small cloud VM. Without one, it falls back to TCP handshakes to `1.1.1.1:443`.

On the server:

```bash
sudo install -m755 echo/echo-server.py /usr/local/bin/echo-server.py
sudo install -m644 echo/echo-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now echo-server
```

Allow UDP 5201 **from your home IP only**, in both the cloud provider's network rules and the host firewall. For example, with firewalld:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<home-ip>/32 port port=5201 protocol=udp accept'
sudo firewall-cmd --reload
```

Most home IPs are dynamic. When yours changes, the reflector stops answering and the dashboard falls back to the TCP probe until you update the rule.

On the box, point the dashboard at the reflector without editing the unit file:

```bash
sudo mkdir -p /etc/systemd/system/netmon.service.d
printf '[Service]\nEnvironment=NETMON_ECHO_HOST=reflector.example.com\n' | sudo tee /etc/systemd/system/netmon.service.d/echo.conf
sudo systemctl daemon-reload && sudo systemctl restart netmon
```

The chart caption on the dashboard shows which probe is in use.

## Upgrading an older install

Before 2026-09-30, the NAT, marking and accounting rules lived in `/etc/nftables.conf` as `table ip nat`, `table ip mangle` and `table ip accounting`. `router-shaper` now creates its own table instead. After running the new installer, remove the old tables from `/etc/nftables.conf` (keep a copy) and delete them from the running ruleset:

```bash
sudo nft delete table ip nat; sudo nft delete table ip mangle; sudo nft delete table ip accounting
```

The installer warns while they are still present. Leaving them does no harm beyond applying NAT and marking twice, but the dashboard reads only the new table.

## Manual installation

For distributions without `apt`, or to see exactly what happens, these are the installer's steps:

```bash
sudo install -m755 router/router-shaper /usr/local/sbin/router-shaper
sudo install -m644 router/router-shaper.conf.example /etc/router-shaper.conf   # set WAN_IF, LAN_SUBNET, DL_RATE, UL_RATE
sudo install -m644 router/router-shaper.service /etc/systemd/system/
sudo install -m644 router/sysctl-router.conf /etc/sysctl.d/90-one-armed-cake.conf
sudo systemctl daemon-reload && sudo systemctl enable --now router-shaper
router-shaper status
```

For DHCP, fill in the `@...@` placeholders in `router/dnsmasq-router.conf.in` and install it as `/etc/dnsmasq.d/one-armed-cake.conf`. For the dashboard, copy `dashboard/server.ts` and `dashboard/index.html` to `/opt/netmon/` and install `dashboard/netmon.service`. The dashboard reads `WAN_IF` and `LAN_SUBNET` from `/etc/router-shaper.conf`.

`router-shaper` must have LF line endings: a Windows CRLF in the `#!/bin/bash` line makes it fail with "No such file or directory".

If the host runs **firewalld or ufw**, allow forwarding between the LAN and itself on `WAN_IF`. Their own forward chains can drop routed packets before this project's rules see them.

## Windows

There is no native Windows version. Windows has no equivalent of CAKE for traffic it forwards for other devices, and Windows 11 has no DHCP server. The options are:

- **A Linux VM under Hyper-V** (Windows Pro, Enterprise or Education). Create an external virtual switch on the PC's Ethernet adapter, install Debian in a VM on that switch, and run `install.sh` inside it. This works as described above, but in whole-house mode the house has no internet whenever the PC is off, asleep or rebooting for updates. A Pi draws 3-5 W; a desktop left on draws 60-100 W or more.
- **Shaping only the PC itself** would need a different design: a per-machine shaper on the WinDivert packet driver. It could fix the lag the PC's own transfers cause, but not lag from other devices' traffic. It does not exist yet.
- **WSL does not work.** Its kernel has no CAKE, and its network sits behind a NAT on the host.

## Uninstall

```bash
sudo ./install.sh --uninstall
```

This stops the services, deletes the nftables table (NAT stops, so the box stops being a router) and removes the installed files. It keeps `/etc/router-shaper.conf` and the dashboard's name cache in `/var/lib/netmon`. If the box was serving DHCP, turn the ISP router's DHCP server back on first.
