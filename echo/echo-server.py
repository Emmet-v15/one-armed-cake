#!/usr/bin/env python3
"""UDP echo reflector for the dashboard's game-style latency probe.

Bounces each datagram straight back, so the client measures round-trip time
per packet and sees loss as loss. (A TCP-handshake probe turns one lost packet
into a ~1 s sample, because the kernel retransmits a SYN after one second.)

Run it on a host near your ISP's network that you control, and firewall the
port so only your own public IP can reach it. It echoes small packets only,
so it cannot be used for amplification.

    python3 echo-server.py [port]        # default 5201
"""
import socket
import sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5201
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", port))
while True:
    data, addr = s.recvfrom(2048)
    if len(data) <= 128:
        s.sendto(data, addr)
