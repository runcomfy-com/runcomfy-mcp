from __future__ import annotations

import uvicorn

from container_runtime import error_details, get_container_port, log_event, optional_env, validate_runtime_environment


def main() -> None:
    validate_runtime_environment()
    port = get_container_port()
    log_level = optional_env("RUNCOMFY_LOG_LEVEL") or "info"
    log_event("info", "python.starting", port=port, log_level=log_level)
    uvicorn.run(
        "container_app:app",
        host="0.0.0.0",
        port=port,
        proxy_headers=True,
        access_log=False,
        log_level=log_level,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        log_event("error", "python.startup.failed", error=error_details(exc))
        raise
