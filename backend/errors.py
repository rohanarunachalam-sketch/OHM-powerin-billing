"""Application errors and FastAPI exception handlers.

Clients receive short, user-friendly messages; full tracebacks only go to the log.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("billing")


class AppError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class NotFoundError(AppError):
    def __init__(self, what: str) -> None:
        super().__init__(f"{what} not found.", 404)


class ConflictError(AppError):
    def __init__(self, message: str) -> None:
        super().__init__(message, 409)


_FIELD_LABELS = {
    "gstin": "GSTIN",
    "hsn_sac": "HSN/SAC",
    "ifsc": "IFSC",
    "pan": "PAN",
    "upi_id": "UPI ID",
    "gst_rate": "GST rate",
    "state_code": "State",
    "place_of_supply": "Place of supply",
}


def _describe_validation_error(error: dict) -> str:
    location = [str(part) for part in error.get("loc", ()) if part not in ("body", "query", "path")]
    message = error.get("msg", "Invalid value").removeprefix("Value error, ")
    if not location:
        return message
    label_parts = []
    for part in location:
        if part.isdigit():
            label_parts.append(f"#{int(part) + 1}")
        else:
            label_parts.append(_FIELD_LABELS.get(part, part.replace("_", " ").capitalize()))
    return f"{' '.join(label_parts)}: {message}"


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        messages = [_describe_validation_error(e) for e in exc.errors()]
        return JSONResponse(
            status_code=422,
            content={"detail": messages[0] if messages else "Invalid input.", "errors": messages},
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={"detail": "Something went wrong on the server. Please try again."},
        )
