#!/usr/bin/env python3
"""Tiny local web server for Private Redactor (Python 3 standard library only).

Browsers will not run the in-browser AI from a double-clicked file, so this
serves the folder on http://localhost and opens it. It listens on this
computer only; nothing is reachable from the network.
"""
import http.server
import os
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
PORTS = range(8731, 8741)

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".cact": "application/octet-stream",
    ".svg": "image/svg+xml",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):  # keep the window quiet
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    for port in PORTS:
        try:
            server = Server(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    else:
        print("Could not find a free port (tried 8731-8740). Close other copies and try again.")
        sys.exit(1)
    url = f"http://localhost:{port}/"
    print("\n  Private Redactor is running.")
    print(f"  If your browser did not open, go to:  {url}")
    print("  Keep this window open while you work. Close it to stop.\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
