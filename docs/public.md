# Public view

The dashboard can be published on a domain as a **read-only, anonymized** page, for checking on the network from outside the house or for showing it to others. The LAN dashboard is unchanged.

```
viewer ──HTTPS──> server: nginx ──> netmon-relay ──┐  one connection, only while someone watches
                                                    │
router: netmon (127.0.0.1:8081) <── reverse SSH tunnel, opened outbound by the router
```

Nothing on the home network is opened to the internet. The router dials out to a server you control, so this works behind double NAT and survives home IP changes.

## What a visitor can and cannot see

| shown | hidden |
|---|---|
| line throughput, latency chart, histogram, CAKE statistics | device names, MAC addresses, LAN addresses, vendors, leases |
| each device's live rates and totals, under a random 4-character ID | the reflector's hostname |
| the operating system guessed for each device ("Windows device") | anything that is not explicitly listed in `publicView()` |
| the current profile | the profile switch (shown, disabled) |

The public listener builds its snapshot field by field (`publicView()` in `dashboard/server.ts`), so a field added to the dashboard later stays private until someone adds it there. Device IDs are a salted hash, drawn fresh at every dashboard restart: they cannot be reversed and do not link across restarts.

Write protection comes in three layers, any one of which is enough. The public listener answers only GET, the relay answers only GET, and nginx denies every other method.

## Cost on the home line

The relay keeps **one** stream from the router however many people watch, and closes it 30 s after the last viewer leaves. The tunnel compresses it, and SSH marks it CS1, so it travels in CAKE's Bulk tin and cannot delay game traffic. On the reference line one stream used **about 13 kbit/s** of upload (0.7% of 1.8 Mbit/s), and nothing at all with no viewers.

## Setup

You need a server with a public address and a domain name pointing at it. These steps assume nginx with a TLS certificate already in place.

### 1. Router: turn on the public listener

```bash
sudo mkdir -p /etc/systemd/system/netmon.service.d
printf '[Service]\nEnvironment=NETMON_PUBLIC_PORT=8081\n' | sudo tee /etc/systemd/system/netmon.service.d/public.conf
sudo systemctl daemon-reload && sudo systemctl restart netmon
curl -s http://127.0.0.1:8081/api/stats | head -c 200     # anonymized JSON
```

### 2. Router: a key for the tunnel

```bash
sudo install -d -m700 /etc/netmon-tunnel
sudo ssh-keygen -t ed25519 -N "" -C netmon-tunnel -f /etc/netmon-tunnel/id_ed25519
sudo ssh-keyscan -t ed25519 relay.example.com | sudo tee /etc/netmon-tunnel/known_hosts
sudo ssh-keygen -lf /etc/netmon-tunnel/known_hosts         # compare with the server's real host key
printf 'TUNNEL_TARGET=netmon-tunnel@relay.example.com\nLOCAL_PORT=8081\nREMOTE_PORT=18081\n' | sudo tee /etc/netmon-tunnel/env
sudo cat /etc/netmon-tunnel/id_ed25519.pub
```

Check the fingerprint against one you already trust (for example `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server) before relying on it.

### 3. Server: a user that can do nothing but hold the tunnel

```bash
sudo useradd --system --create-home --shell /sbin/nologin netmon-tunnel
sudo install -d -m700 -o netmon-tunnel -g netmon-tunnel /home/netmon-tunnel/.ssh
echo 'restrict,port-forwarding,permitlisten="127.0.0.1:18081",command="/sbin/nologin" <the public key>' |
  sudo install -m600 -o netmon-tunnel -g netmon-tunnel /dev/stdin /home/netmon-tunnel/.ssh/authorized_keys
```

`port-forwarding` in `authorized_keys` re-enables *local* forwards too, which would let the key reach services listening on the server's loopback. Close that in sshd, `/etc/ssh/sshd_config.d/90-netmon-tunnel.conf`:

```
Match User netmon-tunnel
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:18081
    PermitOpen none
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    ForceCommand /sbin/nologin
    # Drop a dead session (router lost power) within ~45 s, freeing the port.
    ClientAliveInterval 15
    ClientAliveCountMax 3
```

```bash
sudo sshd -t && sudo systemctl reload sshd
```

On SELinux systems (RHEL, Oracle Linux, Fedora), run `sudo restorecon -R /home/netmon-tunnel/.ssh`.

### 4. Router: start the tunnel

```bash
sudo install -m644 relay/netmon-tunnel.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now netmon-tunnel
```

On the server, `curl -s http://127.0.0.1:18081/ | head -c 100` should now return the page.

### 5. Server: the relay

```bash
sudo install -m755 "$(command -v bun)" /usr/local/bin/bun
sudo install -Dm644 relay/relay.ts /opt/netmon-relay/relay.ts
sudo install -m644 relay/netmon-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now netmon-relay
```

It listens on `127.0.0.1:3091`. Settings (`RELAY_UPSTREAM`, `RELAY_PORT`, `RELAY_MAX` viewers) are at the top of `relay.ts`.

### 6. Server: nginx

```nginx
limit_req_zone  $binary_remote_addr zone=netmon_req:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=netmon_conn:10m;

server {
    listen 443 ssl;
    http2 on;
    server_name netmon.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    limit_conn netmon_conn 8;

    location = /ws {
        proxy_pass http://127.0.0.1:3091;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 1h;
        proxy_buffering off;
    }

    location / {
        limit_req zone=netmon_req burst=20 nodelay;
        limit_except GET HEAD { deny all; }
        proxy_pass http://127.0.0.1:3091;
        proxy_set_header Host $host;
    }
}
```

## Troubleshooting

**The page says the home network is not reachable.** The tunnel is down. On the router: `systemctl status netmon-tunnel`. It retries every 10 s. On the server, `ss -ltn | grep 18081` shows whether the forward is listening.

**`remote port forwarding failed for listen port 18081`.** A previous tunnel's session still holds the port on the server. With the `ClientAlive` settings above, the server drops a dead session within about 45 s and the router's next retry succeeds. Without them it can take hours. On the reference setup, a 70 s silent outage (every packet dropped, no clean disconnect) recovered on its own 9 s after the link returned.

**Turning it off.** `sudo systemctl disable --now netmon-tunnel` on the router cuts the page off at once, and removing `public.conf` turns off the listener.
