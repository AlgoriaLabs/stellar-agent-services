"""An existing HTTP API with no idea of payments: the kind of service gateway mode puts on Stellar.

It knows nothing about x402, jobs or Stellar. provider-kit's gateway (provider.config.json) sits in
front of it: it publishes the manifest, takes the USDC payment, keeps the job for recovery, queues
under load, and POSTs only the validated input here.

Python standard library only:
    python3 app.py                 # listens on 127.0.0.1:5000
    python3 app.py --port 0        # any free port; prints the one it took
"""

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def summarize(text: str, sentences: int) -> dict:
    """A deliberately simple extractive summary: the first sentences, plus counts."""
    parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
    return {
        "summary": " ".join(parts[:sentences]),
        "sentences": len(parts),
        "words": len(text.split()),
    }


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/summarize":
            return self.answer(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        except ValueError:
            return self.answer(400, {"error": "the body is not JSON"})
        # The gateway already checked the input against inputSchema; an API should still not trust it.
        text = body.get("text")
        if not isinstance(text, str):
            return self.answer(400, {"error": "text must be a string"})
        # The gateway sends the job id, so a job it runs again after a restart can be recognized.
        print(f"job {self.headers.get('Idempotency-Key')}: {len(text)} characters", flush=True)
        self.answer(200, summarize(text, int(body.get("sentences", 1))))

    def answer(self, status: int, payload: dict):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"listening on http://{args.host}:{server.server_address[1]}", flush=True)
    server.serve_forever()
