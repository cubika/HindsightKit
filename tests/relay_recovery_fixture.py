"""A tunnel process that can lose forwarding without exiting."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import time

root, mode = Path(sys.argv[1]), sys.argv[2]
counter = root / 'attempts.txt'
attempt = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(attempt))
spec = json.loads((root / 'fixture-spec.json').read_text())
failure = root / 'fail'

if mode == 'startup-stuck' and attempt == 1:
    time.sleep(120)
    raise SystemExit(1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_HEAD(self):
        self.reply(False)

    def do_GET(self):
        self.reply(True)

    def reply(self, body):
        if mode == 'disconnected' and attempt == 1 and failure.exists():
            self.close_connection = True
            return
        if mode == 'unresponsive' and attempt == 1 and failure.exists():
            time.sleep(120)
            return
        payload = b'synthetic recovered relay'
        self.send_response(503 if mode == 'http-error' else 200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if body:
            self.wfile.write(payload)


with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
    print(f'SSH: Forwarding from 127.0.0.1:{server.server_port} to host port {spec["remote_port"]}.', flush=True)
    worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
    worker.start()
    if mode == 'listener-lost' and attempt == 1:
        while not failure.exists():
            time.sleep(0.02)
        server.shutdown()
        server.server_close()
        (root / 'listener-closed').touch()
    time.sleep(120)
