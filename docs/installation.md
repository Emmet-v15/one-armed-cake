# Installation

This guide assumes a Raspberry Pi 4B (any Linux box with one Ethernet port works) on Debian 13, plugged into a LAN port of the ISP router. Commands run as a user with `sudo`.

> **Before you start:** the Pi becomes the default gateway for the whole house. If it goes down, clients lose internet until you re-enable DHCP on the ISP router (see [operations](operations.md#recovery)). Keep that router's admin page reachable.

## 1. Network basics

Give the Pi a **static** address. It must not depend on DHCP, because it is about to become the DHCP server. The examples use `192.168.1.2`, with the ISP router at `192.168.1.1`.

```bash
sudo apt install nftables dnsmasq iproute2
sudo install -m644 router/sysctl-router.conf /etc/sysctl.d/90-router.conf
sudo sysctl --system
```

`sysctl-router.conf` enables forwarding and disables ICMP redirects. Redirects matter: without that setting, the Pi would tell clients "the ISP router is on your subnet, go direct", and traffic would bypass the shaper.

## 2. Firewall, NAT and accounting

```bash
sudo install -m644 router/nftables.conf /etc/nftables.conf
sudo systemctl enable --now nftables
```

Edit `192.168.1.0/24` and `eth0` if your network differs. The ruleset:

- masquerades LAN traffic leaving towards the ISP router
- creates `table ip mangle` chains, whose `forward` chain is owned by `router-shaper` (game marking, optional priority)
- keeps per-host byte counters in dynamic sets for the dashboard

## 3. The shaper

```bash
sudo install -m755 router/router-shaper /usr/local/sbin/router-shaper
sudo install -m644 router/router-shaper.conf.example /etc/router-shaper.conf
sudo install -m644 router/router-shaper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now router-shaper
router-shaper status
```

Set `DL_RATE`, `UL_RATE` and `OVERHEAD` for your line before relying on it. See [configuration](configuration.md#choosing-rates). The script must have LF line endings: a Windows CRLF in the `#!/bin/bash` line makes it fail with "No such file or directory".

## 4. DHCP: make the Pi the gateway

```bash
sudo install -m644 router/dnsmasq-router.conf.example /etc/dnsmasq.d/router.conf
sudo systemctl restart dnsmasq
```

Then **turn off the ISP router's DHCP server**. If both answer, clients get whichever replies first, and some keep the ISP router as their gateway. Their traffic then never touches the Pi. To check, look for two answers:

```bash
sudo nmap --script broadcast-dhcp-discover -e eth0   # run from another Linux host
```

Clients move over when the leases they hold from the ISP router come up for renewal. Rebooting the ISP router forces Wi-Fi clients to reconnect immediately.

## 5. Optional: reduce SD-card writes

```bash
sudo install -Dm644 router/journald-volatile.conf /etc/systemd/journald.conf.d/10-volatile.conf
echo 'tmpfs /tmp tmpfs defaults,noatime,nosuid,nodev,size=512M 0 0' | sudo tee -a /etc/fstab
sudo systemctl mask man-db.timer                   # daily man-page index rebuild, ~3.5 MB per run
echo 'man-db man-db/auto-update boolean false' | sudo debconf-set-selections
```

See [operations](operations.md#sd-card-wear) for what is left.

## 6. Dashboard

```bash
curl -fsSL https://bun.sh/install | bash          # or install Bun another way
sudo install -m755 ~/.bun/bin/bun /usr/local/bin/bun
sudo apt install samba-common-bin ieee-data       # nmblookup + OUI vendor list (device names)
sudo mkdir -p /opt/netmon /var/lib/netmon
sudo install -m644 dashboard/server.ts dashboard/index.html /opt/netmon/
sudo install -m644 dashboard/netmon.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now netmon
```

Open `http://<pi-address>/`. The dashboard runs as root because it reads `tc` and `nft` state and switches profiles. It listens on port 80 of the LAN only; see [dashboard](dashboard.md#security).

Also add `log-dhcp` to dnsmasq (the example config has it). The dashboard reads DHCP requests from the journal to fingerprint client operating systems.

## 7. Optional but recommended: a latency reflector

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

On the Pi, point the dashboard at it without editing the unit file:

```bash
sudo mkdir -p /etc/systemd/system/netmon.service.d
printf '[Service]\nEnvironment=NETMON_ECHO_HOST=reflector.example.com\n' | sudo tee /etc/systemd/system/netmon.service.d/echo.conf
sudo systemctl daemon-reload && sudo systemctl restart netmon
```

The chart caption on the dashboard shows which probe is in use.
