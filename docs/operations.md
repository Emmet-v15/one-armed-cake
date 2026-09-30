# Operations

## Everyday

```bash
router-shaper profile gaming       # low latency under load
router-shaper profile max          # full download speed, latency rises under load
router-shaper status               # CAKE stats, per tin
systemctl status router-shaper netmon
journalctl -u netmon -n 50
```

Or use the switch on the dashboard. Switching is live and does not reset connections.

## Troubleshooting

**A device's traffic doesn't appear on the dashboard.** It is probably not using the Pi as its gateway. Check its gateway setting and lease. The usual cause is the ISP router's DHCP server still answering: see [installation](installation.md#4-dhcp-make-the-pi-the-gateway). Devices with static network settings must be changed by hand.

**The Pi and the ISP router are both unreachable, but the internet works.** Look at the client, not the Pi. A VPN with an exit node, or a "full tunnel", can capture the LAN subnet. For Tailscale, check for a `192.168.1.0/24` route via the tunnel and enable `--exit-node-allow-lan-access`.

**Latency is high in `gaming`.** Check the steady state first. If it is high while the line is saturated, capacity may have dropped below `DL_RATE`. DSL rates drift, so re-run the sweep. A spike only in the first second of a new download is expected (see [configuration](configuration.md#what-it-cannot-fix)).

**The dashboard latency shows `TCP handshake (fallback)`.** The reflector stopped answering: the server is down, its firewall blocks your IP, or your home IP changed. The probe returns to UDP by itself as soon as replies resume.

**The dashboard shows `0` for everything.** Check that `router-shaper` is running (`tc qdisc show dev ifb-up`) and that `netmon` runs as root.

## Recovery

If the Pi dies, the house loses internet, because clients point at it as their gateway. To recover:

1. Re-enable DHCP on the ISP router.
2. Reboot the ISP router (Wi-Fi clients reconnect and pick up the router as gateway), or wait for leases to expire.

Keep the ISP router's admin page reachable from a device with a static IP, or know how to factory-reset it.

## SD-card wear

The Pi mostly *reads* (sysfs counters, `tc` statistics), and reads cause no wear. Swap on Raspberry Pi OS and Debian images is usually zram (RAM), not the card. With the journal in RAM and `/tmp` on tmpfs, what still reaches the card on the reference box (measured from `/proc/diskstats` over a quiet 10-minute window, plus one run of each daily job):

| Source | Per year | Notes |
|---|---|---|
| DHCP lease file | together ~5.4 GB with a 1 h lease (measured); the split between the two is estimated | Rewritten on every renewal; each rewrite costs an ext4 journal commit (tens of KB for a 200-byte file). The example uses 12 h, which cuts this about twelvefold. The dashboard takes presence from ARP, so lease length does not affect it. |
| `systemd-timesyncd` clock file | (see above) | Touched on every sync so a Pi without a real-time clock boots with roughly the right time. Leave it. |
| `man-db.timer` | ~1.3 GB | Masked in the install steps. |
| logrotate, tmpfiles, dpkg backup | < 0.1 GB | |

To measure your own box, compare field 10 (sectors written) of the `mmcblk0` line in `/proc/diskstats` across a window in which you are not logged in, since an SSH session writes too.

```bash
awk '$3=="mmcblk0"{print $10*512/1e6 " MB written since boot"}' /proc/diskstats
```

## IPv6

The Pi does not route IPv6. If the ISP router starts advertising IPv6, clients get a second, unshaped path to the internet. Either keep IPv6 off on the ISP router or extend the setup to route and shape IPv6 on the Pi.
