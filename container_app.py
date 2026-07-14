from __future__ import annotations

import time
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from container_runtime import error_details, log_event
from runcomfy_client import current_user_token
from server import app as server_app


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(raw=scope.get("headers", []))
        request_id = headers.get("x-request-id") or str(uuid.uuid4())

        # Capture the user token forwarded by the Worker so the client
        # can use it for outbound API calls (per-user billing).
        user_token = headers.get("x-runcomfy-user-token") or ""
        token_reset = current_user_token.set(user_token if user_token else None)

        method = scope.get("method", "GET")
        path = scope.get("path", "")
        query_string = scope.get("query_string", b"").decode("utf-8", "ignore")
        started_at = time.perf_counter()
        status_code = 500

        async def send_with_request_id(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                mutable_headers = MutableHeaders(scope=message)
                mutable_headers["x-request-id"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
            log_event(
                "info",
                "python.request.complete",
                request_id=request_id,
                method=method,
                path=path,
                query=query_string,
                status=status_code,
                duration_ms=round((time.perf_counter() - started_at) * 1000, 2),
            )
        except Exception as exc:
            log_event(
                "error",
                "python.request.error",
                request_id=request_id,
                method=method,
                path=path,
                query=query_string,
                duration_ms=round((time.perf_counter() - started_at) * 1000, 2),
                error=error_details(exc),
            )
            raise
        finally:
            current_user_token.reset(token_reset)


app: ASGIApp = RequestContextMiddleware(server_app)
