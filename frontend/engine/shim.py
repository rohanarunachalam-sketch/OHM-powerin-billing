"""Runs the real FastAPI backend inside the browser (Pyodide) so the app works on GitHub Pages.

The browser has no threads, so anyio's thread offloading is replaced by direct calls. Requests arrive from the
service worker through worker.js and are dispatched straight into the ASGI app; nothing here changes any
business logic. Data lives in an SQLite file on a browser-persisted (IndexedDB) filesystem mounted at /data.
"""
import asyncio
import json
import os
import sys

os.environ["BILLING_DATA_DIR"] = "/data"
os.environ["BILLING_INVOICE_DIR"] = "/data/invoices"
os.environ["BILLING_PDF_FONT"] = "/app/fonts/Arimo-Regular.ttf"
os.environ["BILLING_PDF_FONT_BOLD"] = "/app/fonts/Arimo-Bold.ttf"
os.environ.setdefault("BILLING_LOG_LEVEL", "WARNING")
if "/app" not in sys.path:
    sys.path.insert(0, "/app")

import anyio.to_thread  # noqa: E402


async def _run_inline(func, *args, **_kwargs):
    """Single-threaded stand-in for anyio.to_thread.run_sync (used by FastAPI/Starlette for sync endpoints)."""
    return func(*args)


anyio.to_thread.run_sync = _run_inline

from backend.database import init_db  # noqa: E402
from backend.main import app  # noqa: E402

init_db()


async def handle(method, path, headers_json, body):
    """Dispatch one HTTP request into the ASGI app. Returns (status, headers_json, body_bytes)."""
    raw_path, _, query = path.partition("?")
    payload = bytes(body.to_py()) if body is not None else b""
    headers = [(k.lower().encode("latin-1"), str(v).encode("latin-1")) for k, v in json.loads(headers_json).items()]
    headers.append((b"content-length", str(len(payload)).encode()))
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method.upper(),
        "scheme": "http", "path": raw_path, "raw_path": raw_path.encode(), "query_string": query.encode(),
        "root_path": "", "headers": headers, "server": ("localhost", 80), "client": ("127.0.0.1", 0),
    }
    sent = False
    status, out_headers, chunks = 500, [], []

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": payload, "more_body": False}
        await asyncio.Event().wait()  # never "disconnect": streaming responses must run to completion

    async def send(message):
        nonlocal status, out_headers
        if message["type"] == "http.response.start":
            status = message["status"]
            out_headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in message["headers"]]
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    try:
        await app(scope, receive, send)
    except Exception as error:  # last resort: never leave the page hanging
        status, out_headers = 500, [("content-type", "application/json")]
        chunks = [json.dumps({"detail": "Something went wrong. Please try again."}).encode()]
        print("engine error:", repr(error))
    return status, json.dumps(out_headers), b"".join(chunks)
