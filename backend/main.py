"""FastAPI application entry point.

Run from the project root with:  uvicorn backend.main:app --reload
"""
from __future__ import annotations

import logging
import mimetypes
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from .config import FRONTEND_DIR, LOG_LEVEL
from .database import init_db
from .errors import register_exception_handlers
from .routers import customers, dashboard, export, invoices, materials, products, settings

logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

# Windows registries often map .js to text/plain, which browsers reject for ES modules.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Billing Software", version="1.0.0", lifespan=lifespan)
register_exception_handlers(app)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    else:  # static frontend: always revalidate so edited JS/CSS is never served stale
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


for module in (dashboard, customers, products, materials, invoices, settings, export):
    app.include_router(module.router)


@app.get("/api/health", tags=["health"])
def health() -> dict:
    return {"status": "ok"}


# The single-page frontend is served from the same origin, so no CORS is needed.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
