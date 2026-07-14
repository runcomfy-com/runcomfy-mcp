from __future__ import annotations

import json
import os
from typing import Any, Mapping


def log_event(level: str, event: str, **fields: Any) -> None:
    payload = {
        "level": level,
        "event": event,
        "service": "runcomfy-mcp-container",
        **fields,
    }
    print(json.dumps(payload, separators=(",", ":"), default=str), flush=True)


def error_details(exc: BaseException) -> dict[str, str]:
    return {
        "type": exc.__class__.__name__,
        "message": str(exc),
    }


def _required_env(name: str, environ: Mapping[str, str] | None = None) -> str:
    source = environ or os.environ
    value = source.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def optional_env(name: str, environ: Mapping[str, str] | None = None) -> str | None:
    source = environ or os.environ
    value = source.get(name, "").strip()
    return value or None


def get_container_port(default: int = 8000) -> int:
    raw_value = optional_env("PORT")
    if raw_value is None:
        return default
    try:
        port = int(raw_value)
    except ValueError as exc:
        raise RuntimeError("PORT must be a valid integer") from exc
    if port <= 0 or port > 65535:
        raise RuntimeError("PORT must be between 1 and 65535")
    return port


def validate_runtime_environment() -> None:
    _required_env("RUNCOMFY_API_KEY")
