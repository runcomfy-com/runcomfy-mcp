"""RunComfy MCP server — Serverless, Model, and Trainer API wrapper.

Mirrors the RunComfy docs 1:1 across three products:

- **Serverless API (ComfyUI)** — ``docs.runcomfy.com/serverless``. Deployment
  management (v2) plus async queue inference (v1) against your own workflows.
- **Model API** — ``docs.runcomfy.com/model-apis``. On-demand inference on
  hosted models from the RunComfy catalog (the Playground models), with no
  deployment to manage.
- **Trainer API** — ``docs.runcomfy.com/trainer-apis``. Training datasets and
  AI Toolkit LoRA training jobs.

File inputs in ``submit_request`` use one of two patterns per docs:
- Public HTTPS URL: ``"image": "https://example.com/photo.jpg"``
- Base64 inline: ``"image": "data:image/jpeg;base64,/9j/4AAQ..."``

Model API file inputs must be public HTTPS URLs.
"""

from __future__ import annotations

import contextlib
import json
import os
from typing import Any

from dotenv import load_dotenv
from mcp.server.fastmcp import Context, FastMCP
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from runcomfy_client import (
    RUNCOMFY_MODEL_API_BASE_URL,
    RUNCOMFY_SERVERLESS_BASE_URL,
    RUNCOMFY_TRAINER_API_BASE_URL,
    RunComfyAPIError,
    RunComfyModelAPIClient,
    RunComfyServerlessClient,
    RunComfyTrainerAPIClient,
    collect_model_output_urls,
    collect_serverless_output_urls,
    collect_trainer_artifact_urls,
    compact_dataset,
    compact_deployment,
    compact_training_status,
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

# Trainer jobs run on a narrower set than Serverless deployments.
# ADA_80_PLUS is H100 in the Trainer UI; HOPPER_141 is H200.
TRAINER_GPU_CHOICES = ("ADA_80_PLUS", "HOPPER_141")

load_dotenv()

MCP_MOUNT_PREFIX = os.getenv("RUNCOMFY_MCP_MOUNT_PREFIX", "").rstrip("/")
if MCP_MOUNT_PREFIX == "/":
    MCP_MOUNT_PREFIX = ""
if MCP_MOUNT_PREFIX and not MCP_MOUNT_PREFIX.startswith("/"):
    MCP_MOUNT_PREFIX = f"/{MCP_MOUNT_PREFIX}"
FINAL_MCP_PATH = f"{MCP_MOUNT_PREFIX}/mcp" if MCP_MOUNT_PREFIX else "/mcp"

serverless_client = RunComfyServerlessClient(
    base_url=os.getenv("RUNCOMFY_SERVERLESS_BASE_URL", RUNCOMFY_SERVERLESS_BASE_URL),
)
model_client = RunComfyModelAPIClient(
    base_url=os.getenv("RUNCOMFY_MODEL_API_BASE_URL", RUNCOMFY_MODEL_API_BASE_URL),
)
trainer_client = RunComfyTrainerAPIClient(
    base_url=os.getenv("RUNCOMFY_TRAINER_API_BASE_URL", RUNCOMFY_TRAINER_API_BASE_URL),
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
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
WRITE_TOOL = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    openWorldHint=False,
)
# Readiness polling reconciles stored metadata without changing dataset files.
RECONCILE_TOOL = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
# Billable execution and overwrites need destructive hints without adding a
# retry guarantee. Open-world writes can publish output or invoke callbacks.
DESTRUCTIVE_WRITE_TOOL = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    openWorldHint=False,
)
OPEN_WORLD_WRITE_TOOL = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    openWorldHint=True,
)
DESTRUCTIVE_TOOL = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=True,
    openWorldHint=False,
)
OPEN_WORLD_DESTRUCTIVE_TOOL = ToolAnnotations(
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


def _payload_text(payload: dict[str, Any]) -> TextContent:
    """Serialize the structured payload for clients that only read content.

    structuredContent is optional in the MCP spec and many clients ignore it,
    so a tool that puts its data only there appears to return nothing but a
    summary sentence. The spec's guidance is to also serialize the payload
    into a text block, which is what keeps these tools usable everywhere.
    """
    return _text(json.dumps(payload, ensure_ascii=False, default=str))


def ok_result(message: str, data: dict[str, Any]) -> CallToolResult:
    payload: dict[str, Any] = {"ok": True, **data}
    return CallToolResult(
        content=[_text(message), _payload_text(payload)],
        structuredContent=payload,
    )


def error_result(
    message: str, *, data: dict[str, Any] | None = None
) -> CallToolResult:
    payload = data or {"ok": False, "error": message}
    return CallToolResult(
        content=[_text(message), _payload_text(payload)],
        structuredContent=payload,
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


@mcp.tool(name="create_deployment", annotations=DESTRUCTIVE_WRITE_TOOL)
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


@mcp.tool(name="update_deployment", annotations=DESTRUCTIVE_WRITE_TOOL)
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

@mcp.tool(name="submit_request", annotations=OPEN_WORLD_WRITE_TOOL)
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

    This is for ``submit_request`` requests on a deployment. Model API
    requests from ``run_model`` use ``get_model_request_status``.
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

    This is for ``submit_request`` requests on a deployment. Model API
    requests from ``run_model`` use ``get_model_request_result``.
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


@mcp.tool(name="cancel_request", annotations=OPEN_WORLD_DESTRUCTIVE_TOOL)
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

@mcp.tool(name="call_instance_proxy", annotations=OPEN_WORLD_WRITE_TOOL)
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


# ===========================================================================
# Tools — Model API (hosted catalog models)
# ===========================================================================

@mcp.tool(name="list_models", annotations=READ_TOOL)
async def list_models(
    search: str | None = None,
    category: str | None = None,
    kind: str | None = None,
    include_schema: bool = False,
    limit: int = 100,
    offset: int = 0,
) -> CallToolResult:
    """Browse the hosted models that ``run_model`` can run.

    Backs ``GET /v1/models`` on the Model API. Start here when you know
    what you want to generate but not which ``model_id`` provides it.

    Each entry carries the ``model_id`` for ``run_model``, a
    ``display_name`` and ``description``, what it costs
    (``base_price_usd`` per ``price_unit``), a ``model_url`` to the
    model's page, and its ``inputs`` / ``required_inputs``.

    Args:
        search: Case-insensitive match on id, display name, or
            description — e.g. "kontext", "upscale", "lip sync".
        category: Capability filter, e.g. ``text-to-image``,
            ``image-to-video``. Use ``list_model_categories`` for the
            full set.
        kind: How the model runs — ``model``, ``workflow``, or
            ``inference``. Orthogonal to ``category``; filter on
            ``category`` unless you specifically care how it executes.
        include_schema: Return each model's full ``input_schema``
            inline. Much larger response — prefer ``get_model`` for a
            single model, and use this only when comparing many.
        limit: Page size, 1..500.
        offset: Rows to skip. ``total`` is the unpaged count.
    """
    if limit < 1 or limit > 500:
        return error_result("limit must be between 1 and 500.")
    if offset < 0:
        return error_result("offset must be 0 or greater.")
    try:
        payload = await model_client.list_models(
            search=search,
            category=category,
            kind=kind,
            include_schema=include_schema,
            limit=limit,
            offset=offset,
        )
        models = payload.get("models")
        if not isinstance(models, list):
            models = []
        total = payload.get("total", len(models))
        return ok_result(
            f"Showing {len(models)} of {total} model(s).",
            {
                "models": models,
                "total": total,
                "limit": payload.get("limit", limit),
                "offset": payload.get("offset", offset),
            },
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="list_model_categories", annotations=READ_TOOL)
async def list_model_categories() -> CallToolResult:
    """List the capability categories models are grouped into.

    Backs ``GET /v1/models/categories``. Returns values such as
    ``text-to-image`` and ``image-to-video`` — pass one to
    ``list_models(category=...)``.
    """
    try:
        payload = await model_client.list_model_categories()
        categories = payload.get("categories")
        if not isinstance(categories, list):
            categories = []
        return ok_result(
            f"{len(categories)} category(ies).",
            {"categories": categories},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="get_model", annotations=READ_TOOL)
async def get_model(model_id: str) -> CallToolResult:
    """Get one hosted model's input schema.

    Backs ``GET /v1/models/{model_id}``. The ``input_schema`` is the
    JSON Schema for ``run_model``'s ``inputs`` — property types,
    defaults, enums, and min/max ranges — so read it before building a
    request rather than guessing parameter names. Properties whose
    ``format`` is ``image_uri``/``video_uri``/``audio_uri`` take a
    public HTTPS URL.

    Also returns ``description``, ``categories``, ``base_price_usd``
    per ``price_unit``, and ``model_url``.

    Args:
        model_id: The model's identifier, slashes included, e.g.
            ``blackforestlabs/flux-1-kontext/pro/edit``. Find one with
            ``list_models``.
    """
    normalized_model_id = model_id.strip().strip("/")
    if not normalized_model_id:
        return error_result("model_id is required.")
    try:
        payload = await model_client.get_model(normalized_model_id)
        return ok_result(
            f"Loaded model {normalized_model_id}.",
            {"model": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="run_model", annotations=OPEN_WORLD_WRITE_TOOL)
async def run_model(
    model_id: str,
    inputs: dict[str, Any] | None = None,
    wait_for_completion: bool = False,
    timeout_seconds: int = 300,
    ctx: Context | None = None,
) -> CallToolResult:
    """Run a hosted RunComfy model on demand — no deployment needed.

    Backs ``POST /v1/models/{model_id}`` on the Model API. Returns a
    ``request_id`` immediately; poll with ``get_model_request_status``
    and fetch outputs with ``get_model_request_result``.

    Args:
        model_id: The model's identifier exactly as shown on its page at
            runcomfy.com/models, e.g.
            ``blackforestlabs/flux-1-kontext/pro/edit``. Slashes are part
            of the ID.
        inputs: Request body matching the model's Input schema (model
            page → API → Input schema), e.g.
            ``{"prompt": "a cat", "aspect_ratio": "16:9", "seed": 42}``.
        wait_for_completion: If true, poll until done and return the
            result inline.
        timeout_seconds: Max wait when wait_for_completion=true.

    File inputs must be publicly accessible HTTPS URLs that a plain
    unauthenticated GET can fetch, e.g.
    ``{"image_url": "https://example.com/photo.webp"}``.

    To run a Trainer LoRA without deploying it, call the LoRA's *base
    model* ID here and pass the LoRA in the body, e.g.
    ``{"lora": {"path": "my_first_lora_3000.safetensors"}}`` — either a
    LoRA name from your RunComfy LoRA Assets or a public URL.
    """
    normalized_model_id = model_id.strip().strip("/")
    if not normalized_model_id:
        return error_result("model_id is required.")
    try:
        submission = await model_client.submit_request(
            normalized_model_id,
            request_body=inputs,
        )
        request_id = submission.get("request_id")
        if ctx is not None and request_id:
            await ctx.info(f"Submitted model request {request_id}")

        if not wait_for_completion or not request_id:
            return ok_result(
                f"Submitted model request {request_id}.",
                {"submission": submission, "model_id": normalized_model_id},
            )

        async def on_status(status_payload: dict[str, Any]) -> None:
            if ctx is None:
                return
            await ctx.info(f"Request status: {status_payload.get('status')}")

        wait_result = await model_client.wait_for_completion(
            str(request_id),
            timeout_seconds=float(timeout_seconds),
            on_status=on_status,
        )
        status_payload = wait_result["status_payload"]
        result_payload = wait_result["result_payload"]
        return ok_result(
            f"Model request {request_id} finished: {status_payload.get('status')}.",
            {
                "submission": submission,
                "model_id": normalized_model_id,
                "status": status_payload,
                "result": result_payload,
                "output_urls": collect_model_output_urls(result_payload),
            },
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)
    except TimeoutError as exc:
        return error_result(str(exc), data={"ok": False, "error": str(exc)})


@mcp.tool(name="get_model_request_status", annotations=READ_TOOL)
async def get_model_request_status(request_id: str) -> CallToolResult:
    """Poll a Model API request's current status.

    Backs ``GET /v1/requests/{request_id}/status``.
    Lifecycle: ``in_queue`` → ``in_progress`` → ``completed`` /
    ``cancelled``. While ``in_queue`` the payload also carries
    ``queue_position``.

    This is for ``run_model`` requests. Serverless deployment requests
    use ``get_request_status`` instead.
    """
    try:
        payload = await model_client.get_request_status(request_id)
        return ok_result(
            f"Model request {request_id}: {payload.get('status')}.",
            {"status": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="get_model_request_result", annotations=READ_TOOL)
async def get_model_request_result(request_id: str) -> CallToolResult:
    """Fetch a completed Model API request's outputs.

    Backs ``GET /v1/requests/{request_id}/result``. The ``output`` shape
    is defined by the model's Output schema; any hosted asset URLs found
    in it are also flattened into ``output_urls``.

    This is for ``run_model`` requests. Serverless deployment requests
    use ``get_request_result`` instead.
    """
    try:
        payload = await model_client.get_request_result(request_id)
        return ok_result(
            f"Model result for {request_id}: {payload.get('status')}.",
            {
                "result": payload,
                "output_urls": collect_model_output_urls(payload),
            },
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="cancel_model_request", annotations=DESTRUCTIVE_TOOL)
async def cancel_model_request(request_id: str) -> CallToolResult:
    """Cancel a queued Model API request.

    Backs ``POST /v1/requests/{request_id}/cancel``. Returns
    ``cancelled`` if accepted, ``not_cancellable`` if the request is
    already in progress or finished.
    """
    try:
        payload = await model_client.cancel_request(request_id)
        return ok_result(
            f"Cancel model request {request_id}: {payload.get('outcome')}.",
            {"cancel": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


# ===========================================================================
# Tools — Trainer API (datasets)
# ===========================================================================

@mcp.tool(name="create_dataset", annotations=WRITE_TOOL)
async def create_dataset(name: str | None = None) -> CallToolResult:
    """Create an empty training dataset.

    Backs ``POST /prod/v1/trainers/datasets``. The new dataset starts in
    ``DRAFT``; upload files into it, then poll ``get_dataset_status``
    until it reaches ``READY`` before submitting a training job.

    Args:
        name: Human-readable name, unique within the account. This is
            the ``dataset_name`` an AI Toolkit config references as
            ``/app/ai-toolkit/datasets/{dataset_name}``. Omit to let
            RunComfy generate one.
    """
    try:
        dataset = await trainer_client.create_dataset(name=name)
        return ok_result(
            f"Created dataset {dataset.get('id')} ({dataset.get('name')}).",
            {"dataset": dataset},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="list_datasets", annotations=READ_TOOL)
async def list_datasets(include_raw: bool = False) -> CallToolResult:
    """List training datasets in the caller's account.

    Backs ``GET /prod/v1/trainers/datasets``. Use it to find the
    ``id`` (for upload/status/delete calls) and the ``name`` (for the
    ``folder_path`` in an AI Toolkit config). The listing carries no
    per-file detail — use ``get_dataset_status`` for a dataset's files.

    Args:
        include_raw: Return each dataset's unabridged payload instead of
            the compact summary. Larger response.
    """
    try:
        payload = await trainer_client.list_datasets()
        datasets = payload.get("datasets")
        if not isinstance(datasets, list):
            datasets = []
        if not include_raw:
            datasets = [
                compact_dataset(d) for d in datasets if isinstance(d, dict)
            ]
        return ok_result(
            f"Found {len(datasets)} dataset(s).",
            {"datasets": datasets},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="get_dataset_status", annotations=RECONCILE_TOOL)
async def get_dataset_status(dataset_id: str) -> CallToolResult:
    """Get a dataset's status and its successfully uploaded files.

    Backs ``GET /prod/v1/trainers/datasets/{dataset_id}/status``.
    Lifecycle: ``DRAFT`` → ``UPLOADING`` → ``READY`` (or ``FAILED``,
    which sets ``error``). Only ``READY`` datasets can be mounted by a
    training job. Files still uploading or failed do not appear in
    ``files``.
    """
    try:
        payload = await trainer_client.get_dataset_status(dataset_id)
        return ok_result(
            f"Dataset {dataset_id}: {payload.get('status')}.",
            {"dataset": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="delete_dataset", annotations=OPEN_WORLD_DESTRUCTIVE_TOOL)
async def delete_dataset(dataset_id: str) -> CallToolResult:
    """Permanently delete a training dataset.

    Backs ``DELETE /prod/v1/trainers/datasets/{dataset_id}``. This
    cannot be undone.
    """
    try:
        payload = await trainer_client.delete_dataset(dataset_id)
        return ok_result(
            f"Deleted dataset {dataset_id}.",
            {"response": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="upload_dataset_file_from_url", annotations=OPEN_WORLD_WRITE_TOOL)
async def upload_dataset_file_from_url(
    dataset_id: str,
    source_url: str,
    filename: str | None = None,
) -> CallToolResult:
    """Add one file to a dataset by fetching it from a public URL.

    Downloads ``source_url`` and forwards the bytes to
    ``POST /prod/v1/trainers/datasets/{dataset_id}/upload``.

    Args:
        dataset_id: Target dataset.
        source_url: Publicly reachable HTTPS URL for an image, video, or
            caption ``.txt`` file. Must be under 150 MB.
        filename: Name to store it under. Defaults to the URL's
            basename. For LoRA training each image/video needs a caption
            ``.txt`` with the *same base name* — ``img_0001.jpg`` pairs
            with ``img_0001.txt``.

    Re-uploading the same filename overwrites the previous copy. For
    files the caller holds locally, or anything over 150 MB, use
    ``get_dataset_upload_urls`` and PUT the bytes directly instead.
    """
    if not source_url.startswith(("http://", "https://")):
        return error_result(
            "source_url must be a public http(s) URL. For local files, use "
            "get_dataset_upload_urls and PUT the bytes to the signed URL."
        )
    try:
        payload = await trainer_client.upload_small_file_from_url(
            dataset_id,
            source_url=source_url,
            filename=filename,
        )
        return ok_result(
            f"Uploaded {payload.get('filename')} to dataset {dataset_id}.",
            {"file": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)
    except ValueError as exc:
        return error_result(str(exc), data={"ok": False, "error": str(exc)})


@mcp.tool(name="upload_dataset_text_file", annotations=OPEN_WORLD_WRITE_TOOL)
async def upload_dataset_text_file(
    dataset_id: str,
    filename: str,
    text: str,
) -> CallToolResult:
    """Add a text file — normally a caption — to a dataset.

    Backs ``POST /prod/v1/trainers/datasets/{dataset_id}/upload`` with
    inline text, so captions can be written without hosting a file.

    Args:
        dataset_id: Target dataset.
        filename: Must share the base name of the media it captions:
            ``img_0001.jpg`` → ``img_0001.txt``.
        text: Caption body.
    """
    if not filename.strip():
        return error_result("filename is required.")
    try:
        payload = await trainer_client.upload_text_file(
            dataset_id,
            filename=filename.strip(),
            text=text,
        )
        return ok_result(
            f"Uploaded {payload.get('filename')} to dataset {dataset_id}.",
            {"file": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)
    except ValueError as exc:
        return error_result(str(exc), data={"ok": False, "error": str(exc)})


@mcp.tool(name="get_dataset_upload_urls", annotations=WRITE_TOOL)
async def get_dataset_upload_urls(
    dataset_id: str,
    filename_to_byte_size: dict[str, int],
) -> CallToolResult:
    """Get signed upload URLs for dataset files the server cannot fetch.

    Backs ``POST /prod/v1/trainers/datasets/{dataset_id}/get-upload-endpoint``.
    Use this for local files and for anything over 150 MB: the caller
    PUTs each file's bytes to the returned ``upload_url`` using the
    returned ``method`` and ``headers``.

    Args:
        dataset_id: Target dataset.
        filename_to_byte_size: Map of filename → exact size in bytes,
            e.g. ``{"img_0001.jpg": 2000000, "img_0001.txt": 12000}``.
            The signature is derived from the size, so a wrong value is
            rejected by storage at PUT time.

    Signed URLs are short-lived; call this again for a fresh one if it
    expires. After every PUT succeeds, poll ``get_dataset_status`` until
    the dataset is ``READY``.
    """
    if not filename_to_byte_size:
        return error_result("filename_to_byte_size must not be empty.")
    invalid = [
        name
        for name, size in filename_to_byte_size.items()
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0
    ]
    if invalid:
        return error_result(
            f"Byte size must be a positive integer for: {sorted(invalid)}."
        )
    try:
        payload = await trainer_client.get_upload_endpoints(
            dataset_id,
            filename_to_byte_size=filename_to_byte_size,
        )
        uploads = payload.get("uploads")
        count = len(uploads) if isinstance(uploads, dict) else 0
        return ok_result(
            f"Issued {count} signed upload URL(s) for dataset {dataset_id}.",
            {"uploads": uploads if isinstance(uploads, dict) else payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


# ===========================================================================
# Tools — Trainer API (AI Toolkit training jobs)
# ===========================================================================

@mcp.tool(name="submit_training_job", annotations=OPEN_WORLD_WRITE_TOOL)
async def submit_training_job(
    config_file: str,
    gpu_type: str = "ADA_80_PLUS",
    gpu_count: int | None = None,
    gpu_id: str | None = None,
    ctx: Context | None = None,
) -> CallToolResult:
    """Submit an AI Toolkit training job (typically LoRA training).

    Backs ``POST /prod/v1/trainers/ai-toolkit/jobs``. The job mounts a
    ``READY`` dataset and runs the config you supply. Training runs for
    hours — this returns as soon as the job is queued; track it with
    ``get_training_job_status`` and pull artifacts with
    ``get_training_job_result``.

    Args:
        config_file: The complete AI Toolkit YAML config as a string.
            Two paths in it are fixed by the platform:
            ``training_folder`` must be ``/app/ai-toolkit/output``, and
            the dataset's ``folder_path`` must be
            ``/app/ai-toolkit/datasets/{dataset_name}`` where
            ``dataset_name`` is the dataset's ``name`` (not its id).
        gpu_type: ``ADA_80_PLUS`` (H100) or ``HOPPER_141`` (H200).
        gpu_count: 1 for single-GPU (default), or 8 for multi-GPU.
            Multi-GPU is only supported on ``ADA_80_PLUS``.
        gpu_id: Optional specific GPU selector, e.g. ``"#1"``.
    """
    if gpu_type not in TRAINER_GPU_CHOICES:
        return error_result(
            f"Invalid gpu_type {gpu_type!r}. "
            f"Must be one of {list(TRAINER_GPU_CHOICES)}."
        )
    if not config_file.strip():
        return error_result("config_file is required (AI Toolkit YAML).")
    if gpu_count is not None and gpu_count not in (1, 8):
        return error_result("gpu_count must be 1 or 8.")
    if gpu_count == 8 and gpu_type != "ADA_80_PLUS":
        return error_result(
            "Multi-GPU (gpu_count=8) is only supported on ADA_80_PLUS."
        )
    try:
        job = await trainer_client.submit_training_job(
            config_file=config_file,
            gpu_type=gpu_type,
            gpu_count=gpu_count,
            gpu_id=gpu_id,
        )
        if ctx is not None and job.get("id"):
            await ctx.info(f"Submitted training job {job.get('id')}")
        return ok_result(
            f"Submitted training job {job.get('id')} ({job.get('name')}).",
            {"job": job},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="get_training_job_status", annotations=READ_TOOL)
async def get_training_job_status(job_id: str) -> CallToolResult:
    """Poll a training job's status and step progress.

    Backs ``GET /prod/v1/trainers/ai-toolkit/jobs/{job_id}/status``.
    Lifecycle: ``IN_QUEUE`` → ``RUNNING`` → ``STOPPED`` (finished or
    preempted), ``FAILED`` (``error`` explains why), or ``CANCELED``.
    """
    try:
        payload = await trainer_client.get_training_job_status(job_id)
        return ok_result(
            f"Training job {job_id}: {payload.get('status')}.",
            {"status": payload, "summary": compact_training_status(payload)},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="get_training_job_result", annotations=READ_TOOL)
async def get_training_job_result(job_id: str) -> CallToolResult:
    """Fetch a training job's artifacts as hosted URLs.

    Backs ``GET /prod/v1/trainers/ai-toolkit/jobs/{job_id}/result``.
    Returns checkpoints (``.safetensors``), the resolved config, and
    sample outputs. Safe to call while the job is still ``RUNNING`` —
    the artifact list grows over time — and after a ``FAILED`` or
    ``CANCELED`` job to recover whatever was produced.

    Feed a checkpoint URL to ``run_model`` as
    ``{"lora": {"path": "<url>"}}`` to run inference on it.
    """
    try:
        payload = await trainer_client.get_training_job_result(job_id)
        return ok_result(
            f"Training result for {job_id}: {payload.get('status')}.",
            {
                "result": payload,
                "artifact_urls": collect_trainer_artifact_urls(payload),
            },
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="cancel_training_job", annotations=DESTRUCTIVE_TOOL)
async def cancel_training_job(job_id: str) -> CallToolResult:
    """Cancel a queued or running training job.

    Backs ``POST /prod/v1/trainers/ai-toolkit/jobs/{job_id}/cancel``.
    Progress stops, but ``get_training_job_result`` still returns any
    checkpoints produced so far.
    """
    try:
        payload = await trainer_client.cancel_training_job(job_id)
        return ok_result(
            f"Cancelled training job {job_id}: {payload.get('status')}.",
            {"job": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="resume_training_job", annotations=OPEN_WORLD_WRITE_TOOL)
async def resume_training_job(job_id: str) -> CallToolResult:
    """Resume a stopped training job from its latest checkpoint.

    Backs ``POST /prod/v1/trainers/ai-toolkit/jobs/{job_id}/resume``.
    Reuses the same ``job_id`` rather than creating a new job, and
    restarts from the highest-step checkpoint (from step 0 if none
    exists). Useful after a preemption; for a ``FAILED`` job, read
    ``error`` from the status first and fix the cause — often via
    ``edit_training_job`` — before resuming.
    """
    try:
        payload = await trainer_client.resume_training_job(job_id)
        return ok_result(
            f"Resumed training job {job_id}.",
            {"job": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


@mcp.tool(name="edit_training_job", annotations=DESTRUCTIVE_WRITE_TOOL)
async def edit_training_job(job_id: str, config_file: str) -> CallToolResult:
    """Replace the config of a non-running training job.

    Backs ``POST /prod/v1/trainers/ai-toolkit/jobs/{job_id}/edit``. Only
    works while the job is ``STOPPED``, ``CANCELED``, or ``FAILED``, and
    ``config.name`` in the new YAML must still match the original job's
    name. GPU type and count are chosen at resume time, so call
    ``resume_training_job`` afterwards to re-queue with the new config.
    """
    if not config_file.strip():
        return error_result("config_file is required (AI Toolkit YAML).")
    try:
        payload = await trainer_client.edit_training_job(
            job_id,
            config_file=config_file,
        )
        return ok_result(
            f"Updated config for training job {job_id}.",
            {"job": payload},
        )
    except RunComfyAPIError as exc:
        return api_error_result(exc)


# ===========================================================================
# Tools — Account
# ===========================================================================

@mcp.tool(name="get_balance", annotations=READ_TOOL)
async def get_balance() -> CallToolResult:
    """Get the account's remaining RunComfy balance.

    Backs ``GET /prod/v2/balance``. One wallet funds every product, so
    this is the figure Serverless deployments, ``run_model`` requests,
    and training jobs all draw down — and the one that gets checked
    before work is allowed to start.

    Returns ``balance_usd`` for reading and ``balance_microdollars``
    (millionths of a dollar) for exact arithmetic.
    """
    try:
        payload = await serverless_client.get_balance()
        usd = payload.get("balance_usd")
        return ok_result(
            f"Remaining balance: ${usd}." if usd is not None else "Loaded balance.",
            {"balance": payload},
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
            await model_client.aclose()
            await trainer_client.aclose()


app = Starlette(
    routes=[
        Route("/", root_info),
        Route("/healthz", healthcheck),
        Mount(MCP_MOUNT_PREFIX or "/", app=mcp.streamable_http_app()),
    ],
    lifespan=lifespan,
)
