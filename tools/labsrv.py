#!/usr/bin/env python3
"""Load server for tools/exp.py, run on a host you control.

TCP only. The first byte a client sends selects the mode:
  "U"  sink: read and discard everything (the client is uploading)
  "D"  source: send zeros until the deadline (the client is downloading)

The UDP latency reflector is a separate, permanent service: echo/echo-server.py.

    python3 labsrv.py --port 5201 --seconds 3500
"""
import argparse
import socket
import threading
import time

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--port", type=int, default=5201)
ap.add_argument("--seconds", type=float, default=3600, help="exit after this long")
args = ap.parse_args()
end = time.time() + args.seconds
blob = bytes(65536)


def serve(c: socket.socket) -> None:
    c.settimeout(3)
    try:
        if c.recv(1) == b"D":
            while time.time() < end:
                c.sendall(blob)
        else:
            while time.time() < end and c.recv(65536):
                pass
    except OSError:
        pass
    finally:
        c.close()


srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", args.port))
srv.listen(64)
srv.settimeout(1)
while time.time() < end:
    try:
        conn, _ = srv.accept()
    except socket.timeout:
        continue
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
