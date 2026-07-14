"""RunComfy MCP server — Serverless API (ComfyUI) wrapper.

Mirrors docs.runcomfy.com/serverless 1:1. Wraps deployment management
(v2) and async queue inference (v1) endpoints.

File inputs in ``submit_request`` use one of two patterns per docs:
- Public HTTPS URL: ``"image": "https://example.com/photo.jpg"``
- Base64 inline: ``"image": "data:image/jpeg;base64,/9j/4AAQ..."``
"""

from __future__ import annotations

import contextlib
import os
from typing import Any

from dotenv import load_dotenv
from mcp.server.fastmcp import Context, FastMCP
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from runcomfy_client import (
    RUNCOMFY_SERVERLESS_BASE_URL,
    RunComfyAPIError,
    RunComfyServerlessClient,
    collect_serverless_output_urls,
    compact_deployment,
    summarize_deployment_payload,
)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HARDWARE_CHOICES = (
    "TURING_16",
    "AMPERE_24",
    "AMPERE_48",
    "ADA_48_PLUS",
    "AMPERE_80",
    "ADA_80_PLUS",
    "HOPPER_141",
)

load_dotenv()

RUNCOMFY_API_KEY = os.getenv("RUNCOMFY_API_KEY")
if not RUNCOMFY_API_KEY:
    raise RuntimeError("RUNCOMFY_API_KEY is required")

MCP_MOUNT_PREFIX = os.getenv("RUNCOMFY_MCP_MOUNT_PREFIX", "").rstrip("/")
if MCP_MOUNT_PREFIX == "/":
    MCP_MOUNT_PREFIX = ""
if MCP_MOUNT_PREFIX and not MCP_MOUNT_PREFIX.startswith("/"):
    MCP_MOUNT_PREFIX = f"/{MCP_MOUNT_PREFIX}"
FINAL_MCP_PATH = f"{MCP_MOUNT_PREFIX}/mcp" if MCP_MOUNT_PREFIX else "/mcp"

serverless_client = RunComfyServerlessClient(
    os.getenv("RUNCOMFY_SERVERLESS_API_KEY", RUNCOMFY_API_KEY),
    base_url=os.getenv("RUNCOMFY_SERVERLESS_BASE_URL", RUNCOMFY_SERVERLESS_BASE_URL),
)

mcp = FastMCP(
    "RunComfy MCP",
    stateless_http=True,
    json_response=True,
)


# ---------------------------------------------------------------------------
# Annotations
# ---------------------------------------------------------------------------

READ_TOOL = ToolAnnotations(
    readOnlyHint=True,
    idempotentHint=True,
    openWorldHint=True,
)
WRITE_TOOL = ToolAnnotations(
    readOnlyHint=False,
    openWorldHint=True,
)
DESTRUCTIVE_TOOL = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=True,
    openWorldHint=True,
)


# ---------------------------------------------------------------------------
# Result helpers
# ---------------------------------------------------------------------------

def _text(value: str) -> TextContent:
    return TextContent(type="text", text=value)


def ok_result(message: str, data: dict[str, Any]) -> CallToolResult:
    return CallToolResult(
        content=[_text(message)],
        structuredContent={"ok": True, **data},
    )


def error_result(
    message: str, *, data: dict[str, Any] | None = None
) -> CallToolResult:
    return CallToolResult(
        content=[_text(message)],
        structuredContent=data or {"ok": False, "error": message},
        isError=True,
    )


def api_error_result(exc: RunComfyAPIError) -> CallToolResult:
    return error_result(
        str(exc),
        data={
            "ok": False,
            "message": exc.message,
            "status_code": exc.status_code,
            "error_code": exc.error_code,
            "detail": exc.detail,
            "payload": exc.payload,
        },
    )


# ===========================================================================
# Tools — Serverless API (ComfyUI)
# ===========================================================================

# ---- Deployment management (v2) ------------------------------------------

@mcp.tool(name="list_deployments", annotations=READ_TOOL)
async def list_deployments(
    ids: list[str] | None = None,
    include_payload: bool = False,
    include_readme: bool = False,
) -> CallToolResult:
    """List Serverless API deployments in the caller's account.

    Backs ``GET /prod/v2/deployments``.

    Args:
        ids: Optional list of deployment IDs to filter to.
        include_payload: Include workflow_api_json, overrides, and
            object_info_url for each deployment. Larger response.
        include_readme: Include the deployment's README markdown.
    """
    try:
        deployments = await serverless_client.list_deployments(
            include_payload=include_payload,
            include_readme=include_readme,
            ids=ids,
        )
        if not include_payload and not include_readme:
            deployments = [compact_deployment(d) for d in deployments]
        return ok_result(
            f"Found {len(deployments)} deployment(s).",
            {"deployments": deployments},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="get_deployment", annotations=READ_TOOL)
async def get_deployment(
    deployment_id: str,
    include_payload: bool = False,
    include_readme: bool = False,
) -> CallToolResult:
    """Get one deployment by ID.

    Backs ``GET /prod/v2/deployments/{deployment_id}``.

    Set include_payload=true to inspect the deployed workflow graph
    (workflow_api_json) and default overrides — use the node IDs and
    input names to build the ``overrides`` for ``submit_request``.
    """
    try:
        deployment = await serverless_client.get_deployment(
            deployment_id,
            include_payload=include_payload,
            include_readme=include_readme,
        )
        data: dict[str, Any] = {"deployment": deployment}
        if include_payload:
            data["payload_summary"] = summarize_deployment_payload(
                deployment.get("payload")
            )
        return ok_result(f"Loaded deployment {deployment_id}.", data)
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="create_deployment", annotations=WRITE_TOOL)
async def create_deployment(
    name: str,
    workflow_id: str,
    workflow_version: str,
    hardware: str = "AMPERE_48",
    min_instances: int = 0,
    max_instances: int = 1,
    queue_size: int = 1,
    keep_warm_duration_in_seconds: int = 60,
) -> CallToolResult:
    """Create a Serverless API (ComfyUI) deployment.

    Backs ``POST /prod/v2/deployments``. For LoRA deployments, create
    via the runcomfy.com UI instead.

    Args:
        name: Human-readable name.
        workflow_id: UUID of the ComfyUI workflow.
        workflow_version: Version label, e.g. "v1".
        hardware: One of TURING_16, AMPERE_24, AMPERE_48, ADA_48_PLUS,
            AMPERE_80, ADA_80_PLUS, HOPPER_141.
        min_instances: 0..30. Warm instance floor (billable if > 0).
        max_instances: 1..60. Concurrency ceiling.
        queue_size: >= 0. Pending requests before scaling up.
        keep_warm_duration_in_seconds: >= 0. Idle timeout.
    """
    if hardware not in HARDWARE_CHOICES:
        return error_result(
            f"Invalid hardware {hardware!r}. "
            f"Must be one of {list(HARDWARE_CHOICES)}."
        )
    try:
        deployment = await serverless_client.create_deployment(
            name=name,
            workflow_id=workflow_id,
            workflow_version=workflow_version,
            hardware=hardware,
            min_instances=min_instances,
            max_instances=max_instances,
            queue_size=queue_size,
            keep_warm_duration_in_seconds=keep_warm_duration_in_seconds,
        )
        return ok_result(
            f"Created deployment {deployment.get('id')}.",
            {"deployment": compact_deployment(deployment)},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="update_deployment", annotations=WRITE_TOOL)
async def update_deployment(
    deployment_id: str,
    name: str | None = None,
    workflow_version: str | None = None,
    hardware: str | None = None,
    min_instances: int | None = None,
    max_instances: int | None = None,
    queue_size: int | None = None,
    keep_warm_duration_in_seconds: int | None = None,
    is_enabled: bool | None = None,
) -> CallToolResult:
    """Partially update a deployment.

    Backs ``PATCH /prod/v2/deployments/{deployment_id}``. Only pass the
    fields you want to change. Set is_enabled=false to pause;
    true to re-enable.
    """
    if hardware is not None and hardware not in HARDWARE_CHOICES:
        return error_result(
            f"Invalid hardware {hardware!r}. "
            f"Must be one of {list(HARDWARE_CHOICES)}."
        )
    if all(
        v is None
        for v in (
            name, workflow_version, hardware, min_instances,
            max_instances, queue_size, keep_warm_duration_in_seconds,
            is_enabled,
        )
    ):
        return error_result("No fields supplied to update.")
    try:
        # Backend requires `name` on every PATCH even for partial updates.
        # Auto-fetch the current name when the caller doesn't supply one.
        if name is None:
            current = await serverless_client.get_deployment(deployment_id)
            name = current.get("name")

        deployment = await serverless_client.update_deployment(
            deployment_id,
            name=name,
            workflow_version=workflow_version,
            hardware=hardware,
            min_instances=min_instances,
            max_instances=max_instances,
            queue_size=queue_size,
            keep_warm_duration_in_seconds=keep_warm_duration_in_seconds,
            is_enabled=is_enabled,
        )
        return ok_result(
            f"Updated deployment {deployment_id}.",
            {"deployment": compact_deployment(deployment)},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="delete_deployment", annotations=DESTRUCTIVE_TOOL)
async def delete_deployment(deployment_id: str) -> CallToolResult:
    """Permanently delete a deployment.

    Backs ``DELETE /prod/v2/deployments/{deployment_id}``. This cannot
    be undone. Consider ``update_deployment(is_enabled=false)`` to pause
    instead.
    """
    try:
        payload = await serverless_client.delete_deployment(deployment_id)
        return ok_result(
            f"Deleted deployment {deployment_id}.",
            {"response": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


# ---- Async queue (v1) ----------------------------------------------------

@mcp.tool(name="submit_request", annotations=WRITE_TOOL)
async def submit_request(
    deployment_id: str,
    overrides: dict[str, Any] | None = None,
    workflow_api_json: dict[str, Any] | None = None,
    extra_data: dict[str, Any] | None = None,
    webhook_url: str | None = None,
    webhook_intermediate_status: bool | None = None,
    wait_for_completion: bool = False,
    timeout_seconds: int = 300,
    ctx: Context | None = None,
) -> CallToolResult:
    """Submit an async inference request to a deployment.

    Backs ``POST /prod/v1/deployments/{deployment_id}/inference``.

    Args:
        deployment_id: Target deployment.
        overrides: Partial graph keyed by node_id, e.g.
            ``{"6": {"inputs": {"text": "a cat"}}}``.
            Use ``get_deployment(include_payload=true)`` to discover
            node IDs and input names.
        workflow_api_json: Advanced — run a different workflow without
            updating the deployment. Omit ``overrides`` in this mode.
        extra_data: E.g. ``{"api_key_comfy_org": "comfyui-..."}`` for
            ComfyUI Core API nodes.
        webhook_url: Push-based updates instead of polling.
        webhook_intermediate_status: Fire webhooks on every status
            change, not just terminal.
        wait_for_completion: If true, poll until done and return the
            result inline.
        timeout_seconds: Max wait when wait_for_completion=true.

    File inputs: pass a public HTTPS URL or Base64 data URI directly
    in the overrides value, e.g.
    ``{"189": {"inputs": {"image": "https://example.com/photo.jpg"}}}``
    or ``{"189": {"inputs": {"image": "data:image/jpeg;base64,/9j..."}}}``.
    """
    try:
        submission = await serverless_client.submit_request(
            deployment_id,
            overrides=overrides,
            workflow_api_json=workflow_api_json,
            extra_data=extra_data,
            webhook_url=webhook_url,
            webhook_intermediate_status=webhook_intermediate_status,
        )
        request_id = submission.get("request_id")
        if ctx is not None and request_id:
            await ctx.info(f"Submitted request {request_id}")

        if not wait_for_completion or not request_id:
            return ok_result(
                f"Submitted request {request_id}.",
                {"submission": submission, "deployment_id": deployment_id},
            )

        async def on_status(status_payload: dict[str, Any]) -> None:
            if ctx is None:
                return
            await ctx.info(
                f"Request status: {status_payload.get('status')}"
            )

        wait_result = await serverless_client.wait_for_completion(
            deployment_id,
            str(request_id),
            timeout_seconds=float(timeout_seconds),
            on_status=on_status,
        )
        status_payload = wait_result["status_payload"]
        result_payload = wait_result["result_payload"]
        output_urls = collect_serverless_output_urls(result_payload)
        return ok_result(
            f"Request {request_id} finished: {status_payload.get('status')}.",
            {
                "submission": submission,
                "deployment_id": deployment_id,
                "status": status_payload,
                "result": result_payload,
                "output_urls": output_urls,
            },
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)
    except TimeoutError as exc:
        return error_result(str(exc), data={"ok": False, "error": str(exc)})


@mcp.tool(name="get_request_status", annotations=READ_TOOL)
async def get_request_status(
    deployment_id: str, request_id: str
) -> CallToolResult:
    """Poll a request's current status.

    Backs ``GET /prod/v1/deployments/{deployment_id}/requests/{request_id}/status``.
    Lifecycle: ``in_queue`` → ``in_progress`` → ``completed`` / ``cancelled``.
    """
    try:
        payload = await serverless_client.get_request_status(
            deployment_id, request_id
        )
        return ok_result(
            f"Request {request_id}: {payload.get('status')}.",
            {"status": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="get_request_result", annotations=READ_TOOL)
async def get_request_result(
    deployment_id: str, request_id: str
) -> CallToolResult:
    """Fetch a completed request's outputs.

    Backs ``GET /prod/v1/deployments/{deployment_id}/requests/{request_id}/result``.
    Output URLs are hosted for 7 days.
    """
    try:
        payload = await serverless_client.get_request_result(
            deployment_id, request_id
        )
        output_urls = collect_serverless_output_urls(payload)
        return ok_result(
            f"Result for {request_id}: {payload.get('status')}.",
            {"result": payload, "output_urls": output_urls},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="cancel_request", annotations=DESTRUCTIVE_TOOL)
async def cancel_request(
    deployment_id: str, request_id: str
) -> CallToolResult:
    """Cancel a queued or running request.

    Backs ``POST /prod/v1/deployments/{deployment_id}/requests/{request_id}/cancel``.
    Returns ``cancelled`` if accepted, ``not_cancellable`` if already done.
    """
    try:
        payload = await serverless_client.cancel_request(
            deployment_id, request_id
        )
        return ok_result(
            f"Cancel {request_id}: {payload.get('outcome')}.",
            {"cancel": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


# ---- Instance proxy (v2) -------------------------------------------------

@mcp.tool(name="call_instance_proxy", annotations=WRITE_TOOL)
async def call_instance_proxy(
    deployment_id: str,
    instance_id: str,
    comfy_backend_path: str,
    request_body: dict[str, Any] | None = None,
) -> CallToolResult:
    """Call a ComfyUI backend endpoint on a live instance.

    Backs ``POST /prod/v2/deployments/{deployment_id}/instances/{instance_id}/proxy/{path}``.

    Get the instance_id from ``get_request_status`` once the status is
    ``in_progress``. Common target: ``api/free`` with
    ``{"unload_models": true}`` to free GPU memory.
    """
    try:
        payload = await serverless_client.call_instance_proxy(
            deployment_id,
            instance_id,
            comfy_backend_path,
            request_body=request_body,
        )
        return ok_result(
            f"Proxied {comfy_backend_path} on instance {instance_id}.",
            {"response": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


# ---------------------------------------------------------------------------
# Starlette app
# ---------------------------------------------------------------------------

async def root_info(_: Any) -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "name": "RunComfy MCP",
            "mcp_path": FINAL_MCP_PATH,
        }
    )


async def healthcheck(_: Any) -> JSONResponse:
    return JSONResponse({"ok": True})


@contextlib.asynccontextmanager
async def lifespan(_: Starlette):
    async with mcp.session_manager.run():
        try:
            yield
        finally:
            await serverless_client.aclose()


app = Starlette(
    routes=[
        Route("/", root_info),
        Route("/healthz", healthcheck),
        Mount(MCP_MOUNT_PREFIX or "/", app=mcp.streamable_http_app()),
    ],
    lifespan=lifespan,
)
