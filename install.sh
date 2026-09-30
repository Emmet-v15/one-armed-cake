#!/bin/bash
# Install one-armed-cake on any Debian-family Linux box (Raspberry Pi OS,
# Debian, Ubuntu) with one wired interface on the same LAN as the ISP router.
#
#   sudo ./install.sh --down 4500kbit --up 1800kbit     shaper + dashboard
#   sudo ./install.sh ... --dhcp                        also serve DHCP (whole house)
#   sudo ./install.sh --dry-run ...                     show what would happen
#   sudo ./install.sh --uninstall
#
# Without --dhcp nothing changes for the rest of the network: point one
# device's gateway at this box by hand to try it. See docs/installation.md.
set -euo pipefail
cd "$(dirname "$0")"

DRY=no DHCP=no DASH=yes UNINSTALL=no LOWWRITES=auto
DOWN="" UP="" IFACE="" PORT=""
usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
    case "$1" in
        --down) DOWN=$2; shift ;;
        --up) UP=$2; shift ;;
        --iface) IFACE=$2; shift ;;
        --port) PORT=$2; shift ;;
        --dhcp) DHCP=yes ;;
        --no-dashboard) DASH=no ;;
        --low-writes) LOWWRITES=yes ;;
        --no-low-writes) LOWWRITES=no ;;
        --dry-run) DRY=yes ;;
        --uninstall) UNINSTALL=yes ;;
        -h|--help) usage ;;
        *) echo "unknown option: $1" >&2; usage 1 ;;
    esac
    shift
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = yes ]; then printf '    %s\n' "$*"; else "$@"; fi; }
# write DEST MODE < content
put()  {
    if [ "$DRY" = yes ]; then printf '    write %s\n' "$1"; cat >/dev/null
    else install -D -m "$2" /dev/stdin "$1"; fi
}

[ "$(id -u)" = 0 ] || [ "$DRY" = yes ] || die "run as root (sudo $0 ...)"
command -v systemctl >/dev/null || die "systemd is required"

# ----------------------------------------------------------------- uninstall --
if [ "$UNINSTALL" = yes ]; then
    say "removing one-armed-cake"
    [ -x /usr/local/sbin/router-shaper ] && run /usr/local/sbin/router-shaper down || true
    run systemctl disable --now netmon router-shaper 2>/dev/null || true
    run rm -f /usr/local/sbin/router-shaper /etc/systemd/system/router-shaper.service \
              /etc/systemd/system/netmon.service /etc/dnsmasq.d/one-armed-cake.conf \
              /etc/sysctl.d/90-one-armed-cake.conf
    run rm -rf /opt/netmon /etc/systemd/system/netmon.service.d
    run systemctl daemon-reload
    if systemctl is-active -q dnsmasq 2>/dev/null; then run systemctl restart dnsmasq; fi
    say "kept /etc/router-shaper.conf and /var/lib/netmon; delete them by hand if you want"
    say "if this box was serving DHCP, turn the ISP router's DHCP server back on now"
    exit 0
fi

# ----------------------------------------------------------------- network ----
ip2int() { local IFS=.; read -r a b c d <<<"$1"; echo $(( (a<<24) + (b<<16) + (c<<8) + d )); }
int2ip() { echo "$(( ($1>>24)&255 )).$(( ($1>>16)&255 )).$(( ($1>>8)&255 )).$(( $1&255 ))"; }

[ -n "$IFACE" ] || IFACE=$(ip -4 route show default | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
[ -n "$IFACE" ] || die "no default route; connect the box to the LAN first (or pass --iface)"
[ -d "/sys/class/net/$IFACE" ] || die "no interface $IFACE"
GATEWAY=$(ip -4 route show default dev "$IFACE" | awk '{print $3; exit}')
read -r CIDR FLAGS < <(ip -4 -o addr show dev "$IFACE" scope global |
    awk '{f=""; for(i=5;i<=NF;i++) if($i=="dynamic") f="dynamic"; print $4, f; exit}') || true
[ -n "${CIDR:-}" ] || die "$IFACE has no IPv4 address"
ADDR=${CIDR%/*} PREFIX=${CIDR#*/}
MASK=$(( (0xffffffff << (32 - PREFIX)) & 0xffffffff ))
NET=$(( $(ip2int "$ADDR") & MASK ))
BCAST=$(( NET | (~MASK & 0xffffffff) ))
LAN_SUBNET="$(int2ip $NET)/$PREFIX"

say "interface $IFACE, this box $ADDR, LAN $LAN_SUBNET, ISP router ${GATEWAY:-?}"
[ -d "/sys/class/net/$IFACE/wireless" ] &&
    warn "$IFACE is Wi-Fi. Every packet crosses the link twice on a one-armed router; use wired Ethernet."
[ -n "$GATEWAY" ] || die "could not find the ISP router (default gateway) on $IFACE"
if [ "${FLAGS:-}" = dynamic ]; then
    if [ "$DHCP" = yes ]; then
        die "$ADDR was assigned by DHCP. Give this box a static address before it becomes the DHCP server."
    fi
    warn "$ADDR was assigned by DHCP. Fine for a trial; make it static (or reserved in the ISP router) before relying on it."
fi

# ------------------------------------------------------------------ kernel ----
say "checking kernel support"
for m in sch_cake ifb; do
    modprobe -q "$m" 2>/dev/null || [ -d "/sys/module/$m" ] ||
        die "kernel module $m is missing. CAKE is in mainline Linux 4.19+; some cloud and WSL kernels leave it out."
done

# ----------------------------------------------------------------- packages ---
PKGS="iproute2 nftables"
[ "$DHCP" = yes ] && PKGS="$PKGS dnsmasq"
[ "$DASH" = yes ] && PKGS="$PKGS ieee-data samba-common-bin"
if command -v apt-get >/dev/null; then
    say "installing packages: $PKGS"
    run apt-get install -y -q $PKGS
else
    warn "no apt-get: install these yourself if missing: $PKGS"
    for c in tc nft; do command -v $c >/dev/null || [ -x /usr/sbin/$c ] || die "$c not found"; done
fi

# ------------------------------------------------------------------- shaper ---
say "installing the shaper"
run install -m755 router/router-shaper /usr/local/sbin/router-shaper
run install -m644 router/router-shaper.service /etc/systemd/system/router-shaper.service
run install -m644 router/sysctl-router.conf /etc/sysctl.d/90-one-armed-cake.conf
if [ -f /etc/router-shaper.conf ]; then
    say "keeping existing /etc/router-shaper.conf"
    [ -z "$DOWN$UP" ] || warn "--down/--up ignored: edit /etc/router-shaper.conf instead"
else
    [ -n "$DOWN" ] && [ -n "$UP" ] || die "first install needs your line rates, e.g. --down 45mbit --up 9mbit.
       Run a speed test with nothing else busy and pass about 90% of each (85% on DSL).
       Too high and the queue stays in the ISP's equipment; too low and you lose speed."
    sed -e "s|^WAN_IF=.*|WAN_IF=$IFACE|" -e "s|^LAN_SUBNET=.*|LAN_SUBNET=$LAN_SUBNET|" \
        -e "s|^DL_RATE=.*|DL_RATE=$DOWN|" -e "s|^UL_RATE=.*|UL_RATE=$UP|" \
        router/router-shaper.conf.example | put /etc/router-shaper.conf 644
    warn "OVERHEAD in /etc/router-shaper.conf is set for VDSL2 (PTM). See docs/configuration.md for cable, fibre and ADSL."
fi
if nft list table ip accounting >/dev/null 2>&1; then
    warn "found tables from an older install (ip nat / ip mangle / ip accounting in /etc/nftables.conf).
         router-shaper now keeps everything in 'table ip one_armed_cake'; remove the old ones from
         /etc/nftables.conf so rules are not applied twice. See docs/operations.md."
fi
run systemctl daemon-reload
run sysctl -q -p /etc/sysctl.d/90-one-armed-cake.conf
run systemctl enable router-shaper
run systemctl restart router-shaper

# -------------------------------------------------------------------- dhcp ----
if [ "$DHCP" = yes ]; then
    [ "$PREFIX" -le 24 ] || die "--dhcp supports /24 or larger LANs; write the dnsmasq config by hand"
    START=$(int2ip $(( NET + 20 ))) END=$(int2ip $(( BCAST - 5 )))
    say "DHCP: handing out $START-$END with $ADDR as gateway and DNS"
    sed -e "s|@IFACE@|$IFACE|g" -e "s|@ROUTER_IP@|$ADDR|g" -e "s|@GATEWAY@|$GATEWAY|g" \
        -e "s|@RANGE_START@|$START|g" -e "s|@RANGE_END@|$END|g" \
        router/dnsmasq-router.conf.in | put /etc/dnsmasq.d/one-armed-cake.conf 644
    run systemctl enable dnsmasq
    run systemctl restart dnsmasq
fi

# --------------------------------------------------------------- low writes ---
if [ "$LOWWRITES" = auto ]; then
    case "$(findmnt -no SOURCE /)" in /dev/mmcblk*) LOWWRITES=yes ;; *) LOWWRITES=no ;; esac
fi
if [ "$LOWWRITES" = yes ]; then
    say "reducing SD-card writes (journal in RAM, no daily man-db rebuild)"
    run install -Dm644 router/journald-volatile.conf /etc/systemd/journald.conf.d/10-volatile.conf
    run systemctl restart systemd-journald
    run systemctl mask man-db.timer
    if command -v debconf-set-selections >/dev/null; then
        if [ "$DRY" = yes ]; then echo "    debconf: man-db/auto-update false"
        else echo 'man-db man-db/auto-update boolean false' | debconf-set-selections; fi
    fi
fi

# ---------------------------------------------------------------- dashboard ---
URL=""
if [ "$DASH" = yes ]; then
    # Bun's own installer puts it in ~/.bun/bin of whoever ran it, which is not
    # on root's PATH under sudo: look there too.
    BUN=$(command -v bun || true)
    HOMES="/root${SUDO_USER:+ $(getent passwd "$SUDO_USER" | cut -d: -f6)}"
    for c in /usr/local/bin/bun $(for h in $HOMES; do echo "$h/.bun/bin/bun"; done); do
        [ -n "$BUN" ] || [ ! -x "$c" ] || BUN=$c
    done
    if [ -z "$BUN" ]; then
        warn "Bun not found: skipping the dashboard. Install Bun (https://bun.sh), copy it to /usr/local/bin, and rerun."
    else
        if [ -z "$PORT" ]; then
            PORT=80
            if ss -Hltn "sport = :80" 2>/dev/null | grep -q . && ! systemctl is-active -q netmon 2>/dev/null; then
                PORT=8080; warn "port 80 is taken; the dashboard will use 8080 (--port to choose)"
            fi
        fi
        say "installing the dashboard on port $PORT"
        [ "$BUN" = /usr/local/bin/bun ] || run install -m755 "$BUN" /usr/local/bin/bun
        run install -Dm644 dashboard/server.ts /opt/netmon/server.ts
        run install -Dm644 dashboard/index.html /opt/netmon/index.html
        run mkdir -p /var/lib/netmon
        run install -m644 dashboard/netmon.service /etc/systemd/system/netmon.service
        printf '[Service]\nEnvironment=NETMON_PORT=%s\n' "$PORT" |
            put /etc/systemd/system/netmon.service.d/port.conf 644
        run systemctl daemon-reload
        run systemctl enable netmon
        run systemctl restart netmon
        URL="http://$ADDR$([ "$PORT" = 80 ] || echo ":$PORT")/"
    fi
fi

# --------------------------------------------------------------------- done ---
echo
say "installed.${URL:+ Dashboard: $URL}"
if [ "$DHCP" = yes ]; then
    cat <<EOF
    Now turn OFF the DHCP server in the ISP router's admin page. If both answer,
    some devices keep the ISP router as their gateway and are never shaped.
    To undo: turn the ISP router's DHCP back on and run: sudo $0 --uninstall
EOF
else
    cat <<EOF
    Nothing else on the network has changed yet. To try it on one device, set
    that device's gateway (router) to $ADDR by hand, keeping its own address.
    For the whole house, rerun with --dhcp (and turn off the ISP router's DHCP).
EOF
fi
