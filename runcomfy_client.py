from __future__ import annotations

import asyncio
import contextvars
import inspect
import mimetypes
import os
import time
from typing import Any, Awaitable, Callable, Iterable
from urllib.parse import urlparse

import httpx

RUNCOMFY_SERVERLESS_BASE_URL = "https://api.runcomfy.net"
RUNCOMFY_MODEL_API_BASE_URL = "https://model-api.runcomfy.net"
RUNCOMFY_TRAINER_API_BASE_URL = "https://trainer-api.runcomfy.net"
SMALL_DATASET_UPLOAD_LIMIT_BYTES = 150_000_000

# Per-request user token forwarded by the Cloudflare Worker.
# When set, outbound API calls use this token instead of the default
# RUNCOMFY_API_KEY, so billing is attributed to the correct user.
current_user_token: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_user_token", default=None
)

StatusCallback = Callable[[dict[str, Any]], Awaitable[None] | None]


class RunComfyAPIError(Exception):
    def __init__(
        self,
        *,
        message: str,
        status_code: int,
        error_code: int | None = None,
        detail: Any | None = None,
        payload: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.error_code = error_code
        self.detail = detail
        self.payload = payload

    def __str__(self) -> str:
        parts = [f"HTTP {self.status_code}"]
        if self.error_code is not None:
            parts.append(f"RunComfy error_code={self.error_code}")
        parts.append(self.message)
        return " | ".join(parts)


class BaseRunComfyClient:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str,
        timeout_seconds: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                # Attribution markers so api.runcomfy.net can identify
                # MCP-originated traffic (filter logs by either header).
                "User-Agent": "runcomfy-mcp/1.0",
                "X-RunComfy-Client": "mcp",
            },
            timeout=timeout_seconds,
            follow_redirects=True,
        )
        self._public_client = httpx.AsyncClient(
            timeout=timeout_seconds,
            follow_redirects=True,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
        await self._public_client.aclose()

    async def _request(
        self,
        method: str,
        path_or_url: str,
        *,
        params: list[tuple[str, str]] | dict[str, str] | None = None,
        json_body: dict[str, Any] | None = None,
        files: Any | None = None,
        data: Any | None = None,
        headers: dict[str, str] | None = None,
        auth: bool = True,
    ) -> Any:
        request_headers = dict(headers or {})
        if json_body is not None and files is None and "Content-Type" not in request_headers:
            request_headers["Content-Type"] = "application/json"

        # Use per-request user token when forwarded by the Worker,
        # so billing is attributed to the calling user. Falls back to
        # the default API key set on the client (for local dev).
        user_token = current_user_token.get()
        if auth and user_token:
            request_headers["Authorization"] = f"Bearer {user_token}"

        client = self._client if auth else self._public_client
        response = await client.request(
            method,
            path_or_url,
            params=params,
            json=json_body,
            files=files,
            data=data,
            headers=request_headers or None,
        )

        try:
            payload: Any = response.json()
        except ValueError:
            payload = response.text

        if response.is_error:
            if isinstance(payload, dict):
                message = (
                    payload.get("error_message")
                    or payload.get("message")
                    or payload.get("error")
                    or (payload.get("detail") if isinstance(payload.get("detail"), str) else None)
                    or response.reason_phrase
                )
                error_code = payload.get("error_code")
                detail = payload.get("detail")
            else:
                message = response.text or response.reason_phrase
                error_code = None
                detail = None

            raise RunComfyAPIError(
                message=message,
                status_code=response.status_code,
                error_code=error_code,
                detail=detail,
                payload=payload,
            )

        # Some RunComfy APIs signal errors with HTTP 200 plus a top-level
        # {"error_code": ..., "error_message": ...} body. Treat those as errors.
        if isinstance(payload, dict) and payload.get("error_code") is not None:
            raise RunComfyAPIError(
                message=payload.get("error_message") or "RunComfy API error",
                status_code=response.status_code,
                error_code=payload.get("error_code"),
                detail=payload.get("detail"),
                payload=payload,
            )

        return payload

    async def download_public_url_bytes(
        self,
        source_url: str,
        *,
        max_bytes: int = SMALL_DATASET_UPLOAD_LIMIT_BYTES,
    ) -> tuple[bytes, str | None]:
        total = 0
        chunks: list[bytes] = []
        async with self._public_client.stream("GET", source_url) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type")
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError(
                        f"Downloaded file is larger than the allowed {max_bytes} bytes"
                    )
                chunks.append(chunk)
        return b"".join(chunks), content_type


class RunComfyServerlessClient(BaseRunComfyClient):
    def __init__(self, api_key: str, *, base_url: str = RUNCOMFY_SERVERLESS_BASE_URL, timeout_seconds: float = 120.0) -> None:
        super().__init__(api_key, base_url=base_url, timeout_seconds=timeout_seconds)

    async def list_deployments(
        self,
        *,
        include_payload: bool = False,
        include_readme: bool = False,
        ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        params: list[tuple[str, str]] = []
        if include_payload:
            params.append(("includes", "payload"))
        if include_readme:
            params.append(("includes", "readme"))
        if ids:
            for deployment_id in ids:
                params.append(("ids", deployment_id))
        return await self._request("GET", "/prod/v2/deployments", params=params or None)

    async def get_deployment(
        self,
        deployment_id: str,
        *,
        include_payload: bool = False,
        include_readme: bool = False,
    ) -> dict[str, Any]:
        params: list[tuple[str, str]] = []
        if include_payload:
            params.append(("includes", "payload"))
        if include_readme:
            params.append(("includes", "readme"))
        return await self._request(
            "GET",
            f"/prod/v2/deployments/{deployment_id}",
            params=params or None,
        )

    async def create_deployment(
        self,
        *,
        name: str,
        workflow_id: str,
        workflow_version: str,
        hardware: str | list[str],
        min_instances: int,
        max_instances: int,
        queue_size: int,
        keep_warm_duration_in_seconds: int,
    ) -> dict[str, Any]:
        hardware_list = hardware if isinstance(hardware, list) else [hardware]
        body: dict[str, Any] = {
            "name": name,
            "workflow_id": workflow_id,
            "workflow_version": workflow_version,
            "hardware": hardware_list,
            "min_instances": min_instances,
            "max_instances": max_instances,
            "queue_size": queue_size,
            "keep_warm_duration_in_seconds": keep_warm_duration_in_seconds,
        }
        return await self._request("POST", "/prod/v2/deployments", json_body=body)

    async def update_deployment(
        self,
        deployment_id: str,
        *,
        name: str | None = None,
        workflow_version: str | None = None,
        hardware: str | list[str] | None = None,
        min_instances: int | None = None,
        max_instances: int | None = None,
        queue_size: int | None = None,
        keep_warm_duration_in_seconds: int | None = None,
        is_enabled: bool | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if workflow_version is not None:
            body["workflow_version"] = workflow_version
        if hardware is not None:
            body["hardware"] = hardware if isinstance(hardware, list) else [hardware]
        if min_instances is not None:
            body["min_instances"] = min_instances
        if max_instances is not None:
            body["max_instances"] = max_instances
        if queue_size is not None:
            body["queue_size"] = queue_size
        if keep_warm_duration_in_seconds is not None:
            body["keep_warm_duration_in_seconds"] = keep_warm_duration_in_seconds
        if is_enabled is not None:
            body["is_enabled"] = is_enabled
        return await self._request(
            "PATCH",
            f"/prod/v2/deployments/{deployment_id}",
            json_body=body,
        )

    async def delete_deployment(self, deployment_id: str) -> dict[str, Any]:
        return await self._request(
            "DELETE",
            f"/prod/v2/deployments/{deployment_id}",
        )

    async def get_object_info(self, object_info_url: str) -> dict[str, Any]:
        return await self._request("GET", object_info_url)

    async def submit_request(
        self,
        deployment_id: str,
        *,
        request_body: dict[str, Any] | None = None,
        overrides: dict[str, Any] | None = None,
        workflow_api_json: dict[str, Any] | None = None,
        extra_data: dict[str, Any] | None = None,
        webhook_url: str | None = None,
        webhook_intermediate_status: bool | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = dict(request_body or {})
        if overrides is not None:
            body["overrides"] = overrides
        if workflow_api_json is not None:
            body["workflow_api_json"] = workflow_api_json
        if extra_data is not None:
            body["extra_data"] = extra_data

        params: dict[str, str] | None = None
        if webhook_url is not None:
            params = {"webhook": webhook_url}
            if webhook_intermediate_status is not None:
                params["webhook_intermediate_status"] = (
                    "true" if webhook_intermediate_status else "false"
                )

        return await self._request(
            "POST",
            f"/prod/v1/deployments/{deployment_id}/inference",
            params=params,
            json_body=body,
        )

    async def get_request_status(self, deployment_id: str, request_id: str) -> dict[str, Any]:
        return await self._request(
            "GET",
            f"/prod/v1/deployments/{deployment_id}/requests/{request_id}/status",
        )

    async def get_request_result(self, deployment_id: str, request_id: str) -> dict[str, Any]:
        return await self._request(
            "GET",
            f"/prod/v1/deployments/{deployment_id}/requests/{request_id}/result",
        )

    async def cancel_request(self, deployment_id: str, request_id: str) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/prod/v1/deployments/{deployment_id}/requests/{request_id}/cancel",
        )

    async def call_instance_proxy(
        self,
        deployment_id: str,
        instance_id: str,
        comfy_backend_path: str,
        *,
        request_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        sanitized_path = comfy_backend_path.lstrip("/")
        return await self._request(
            "POST",
            f"/prod/v2/deployments/{deployment_id}/instances/{instance_id}/proxy/{sanitized_path}",
            json_body=request_body or {},
        )

    async def wait_for_completion(
        self,
        deployment_id: str,
        request_id: str,
        *,
        poll_interval_seconds: float = 3.0,
        timeout_seconds: float = 300.0,
        on_status: StatusCallback | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        last_status: str | None = None

        while True:
            status_payload = await self.get_request_status(deployment_id, request_id)
            status_value = str(status_payload.get("status", "")).lower()

            if on_status is not None and status_value != last_status:
                callback_result = on_status(status_payload)
                if inspect.isawaitable(callback_result):
                    await callback_result
                last_status = status_value

            if status_value in {"completed", "cancelled", "failed"}:
                result_payload = await _safe_fetch(
                    lambda: self.get_request_result(deployment_id, request_id)
                )
                return {
                    "status_payload": status_payload,
                    "result_payload": result_payload,
                }

            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Timed out waiting for RunComfy deployment request {request_id} after {timeout_seconds} seconds"
                )

            await asyncio.sleep(poll_interval_seconds)


class RunComfyModelAPIClient(BaseRunComfyClient):
    def __init__(self, api_key: str, *, base_url: str = RUNCOMFY_MODEL_API_BASE_URL, timeout_seconds: float = 120.0) -> None:
        super().__init__(api_key, base_url=base_url, timeout_seconds=timeout_seconds)

    async def submit_request(
        self,
        model_id: str,
        *,
        request_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/v1/models/{model_id}",
            json_body=request_body or {},
        )

    async def get_request_status(self, request_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/v1/requests/{request_id}/status")

    async def get_request_result(self, request_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/v1/requests/{request_id}/result")

    async def cancel_request(self, request_id: str) -> dict[str, Any]:
        return await self._request("POST", f"/v1/requests/{request_id}/cancel")

    async def wait_for_completion(
        self,
        request_id: str,
        *,
        poll_interval_seconds: float = 3.0,
        timeout_seconds: float = 300.0,
        on_status: StatusCallback | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        last_status: str | None = None

        while True:
            status_payload = await self.get_request_status(request_id)
            status_value = str(status_payload.get("status", "")).lower()

            if on_status is not None and status_value != last_status:
                callback_result = on_status(status_payload)
                if inspect.isawaitable(callback_result):
                    await callback_result
                last_status = status_value

            if status_value in {"completed", "cancelled", "failed"}:
                result_payload = await _safe_fetch(lambda: self.get_request_result(request_id))
                return {
                    "status_payload": status_payload,
                    "result_payload": result_payload,
                }

            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Timed out waiting for RunComfy model request {request_id} after {timeout_seconds} seconds"
                )

            await asyncio.sleep(poll_interval_seconds)


class RunComfyTrainerAPIClient(BaseRunComfyClient):
    def __init__(self, api_key: str, *, base_url: str = RUNCOMFY_TRAINER_API_BASE_URL, timeout_seconds: float = 120.0) -> None:
        super().__init__(api_key, base_url=base_url, timeout_seconds=timeout_seconds)

    async def create_dataset(self, *, name: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if name:
            body["name"] = name
        return await self._request("POST", "/prod/v1/trainers/datasets", json_body=body)

    async def list_datasets(self) -> dict[str, Any]:
        return await self._request("GET", "/prod/v1/trainers/datasets")

    async def get_dataset_status(self, dataset_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/prod/v1/trainers/datasets/{dataset_id}/status")

    async def delete_dataset(self, dataset_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/prod/v1/trainers/datasets/{dataset_id}")

    async def get_upload_endpoints(
        self,
        dataset_id: str,
        *,
        filename_to_byte_size: dict[str, int],
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/prod/v1/trainers/datasets/{dataset_id}/get-upload-endpoint",
            json_body={"filenameToByteSize": filename_to_byte_size},
        )

    async def upload_small_file_bytes(
        self,
        dataset_id: str,
        *,
        filename: str,
        content: bytes,
        content_type: str | None = None,
    ) -> dict[str, Any]:
        if len(content) > SMALL_DATASET_UPLOAD_LIMIT_BYTES:
            raise ValueError(
                f"File {filename} is larger than the direct upload limit of {SMALL_DATASET_UPLOAD_LIMIT_BYTES} bytes"
            )

        guessed_content_type = (
            content_type
            or mimetypes.guess_type(filename)[0]
            or "application/octet-stream"
        )
        files = {"file": (filename, content, guessed_content_type)}
        return await self._request(
            "POST",
            f"/prod/v1/trainers/datasets/{dataset_id}/upload",
            files=files,
        )

    async def upload_small_file_from_url(
        self,
        dataset_id: str,
        *,
        source_url: str,
        filename: str | None = None,
        content_type: str | None = None,
        max_bytes: int = SMALL_DATASET_UPLOAD_LIMIT_BYTES,
    ) -> dict[str, Any]:
        content, downloaded_content_type = await self.download_public_url_bytes(
            source_url,
            max_bytes=max_bytes,
        )
        resolved_filename = filename or _guess_filename_from_url(source_url) or "upload.bin"
        return await self.upload_small_file_bytes(
            dataset_id,
            filename=resolved_filename,
            content=content,
            content_type=content_type or downloaded_content_type,
        )

    async def upload_text_file(
        self,
        dataset_id: str,
        *,
        filename: str,
        text: str,
        encoding: str = "utf-8",
    ) -> dict[str, Any]:
        return await self.upload_small_file_bytes(
            dataset_id,
            filename=filename,
            content=text.encode(encoding),
            content_type="text/plain",
        )

    async def submit_training_job(
        self,
        *,
        config_file: str,
        gpu_type: str,
        gpu_count: int | None = None,
        gpu_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "config_file_format": "yaml",
            "config_file": config_file,
            "gpu_type": gpu_type,
        }
        if gpu_count is not None:
            body["gpu_count"] = gpu_count
        if gpu_id is not None:
            body["gpu_id"] = gpu_id
        return await self._request(
            "POST",
            "/prod/v1/trainers/ai-toolkit/jobs",
            json_body=body,
        )

    async def get_training_job_status(self, job_id: str) -> dict[str, Any]:
        return await self._request(
            "GET",
            f"/prod/v1/trainers/ai-toolkit/jobs/{job_id}/status",
        )

    async def get_training_job_result(self, job_id: str) -> dict[str, Any]:
        return await self._request(
            "GET",
            f"/prod/v1/trainers/ai-toolkit/jobs/{job_id}/result",
        )

    async def cancel_training_job(self, job_id: str) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/prod/v1/trainers/ai-toolkit/jobs/{job_id}/cancel",
        )

    async def resume_training_job(
        self,
        job_id: str,
        *,
        request_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/prod/v1/trainers/ai-toolkit/jobs/{job_id}/resume",
            json_body=request_body or {},
        )

    async def edit_training_job(
        self,
        job_id: str,
        *,
        config_file: str,
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/prod/v1/trainers/ai-toolkit/jobs/{job_id}/edit",
            json_body={
                "config_file_format": "yaml",
                "config_file": config_file,
            },
        )

    async def wait_for_training_completion(
        self,
        job_id: str,
        *,
        poll_interval_seconds: float = 10.0,
        timeout_seconds: float = 28_800.0,
        on_status: StatusCallback | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        last_status: str | None = None

        while True:
            status_payload = await self.get_training_job_status(job_id)
            status_value = str(status_payload.get("status", "")).upper()

            if on_status is not None and status_value != last_status:
                callback_result = on_status(status_payload)
                if inspect.isawaitable(callback_result):
                    await callback_result
                last_status = status_value

            if status_value in {"STOPPED", "FAILED", "CANCELED"}:
                result_payload = await _safe_fetch(lambda: self.get_training_job_result(job_id))
                return {
                    "status_payload": status_payload,
                    "result_payload": result_payload,
                }

            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Timed out waiting for RunComfy trainer job {job_id} after {timeout_seconds} seconds"
                )

            await asyncio.sleep(poll_interval_seconds)


async def _safe_fetch(fetcher: Callable[[], Awaitable[dict[str, Any]]]) -> dict[str, Any] | None:
    try:
        return await fetcher()
    except RunComfyAPIError as exc:
        return {
            "ok": False,
            "error": str(exc),
            "status_code": exc.status_code,
            "error_code": exc.error_code,
            "detail": exc.detail,
            "payload": exc.payload,
        }


def _guess_filename_from_url(source_url: str) -> str | None:
    path = urlparse(source_url).path
    filename = os.path.basename(path)
    return filename or None


def compact_deployment(deployment: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "id",
        "name",
        "workflow_id",
        "workflow_version",
        "hardware",
        "min_instances",
        "max_instances",
        "queue_size",
        "keep_warm_duration_in_seconds",
        "status",
        "is_enabled",
        "created_at",
        "updated_at",
    ]
    return {key: deployment.get(key) for key in keys}


def compact_dataset(dataset: dict[str, Any]) -> dict[str, Any]:
    files = dataset.get("files") if isinstance(dataset.get("files"), list) else None
    return {
        "id": dataset.get("id"),
        "name": dataset.get("name"),
        "status": dataset.get("status"),
        "created_at": dataset.get("created_at"),
        "updated_at": dataset.get("updated_at"),
        "error": dataset.get("error"),
        "files_count": len(files) if files is not None else None,
    }


def compact_training_status(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": payload.get("id"),
        "name": payload.get("name"),
        "status": payload.get("status"),
        "progress": payload.get("progress"),
        "error": payload.get("error"),
        "created_at": payload.get("created_at"),
        "started_at": payload.get("started_at"),
        "finished_at": payload.get("finished_at"),
    }


def summarize_workflow_api_json(
    workflow_api_json: dict[str, Any] | None,
    *,
    limit: int = 200,
) -> list[dict[str, Any]]:
    if not isinstance(workflow_api_json, dict):
        return []

    summary: list[dict[str, Any]] = []
    for node_id, node in workflow_api_json.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        meta = node.get("_meta") if isinstance(node.get("_meta"), dict) else {}
        summary.append(
            {
                "node_id": str(node_id),
                "title": meta.get("title"),
                "class_type": node.get("class_type"),
                "input_names": sorted(list(inputs.keys())),
            }
        )
        if len(summary) >= limit:
            break
    return summary


def summarize_deployment_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"payload_keys": []}

    workflow_api_json = payload.get("workflow_api_json")
    overrides = payload.get("overrides") if isinstance(payload.get("overrides"), dict) else {}

    summary: dict[str, Any] = {
        "payload_keys": sorted(payload.keys()),
        "has_object_info_url": bool(payload.get("object_info_url")),
        "default_override_node_ids": sorted([str(key) for key in overrides.keys()])[:100],
    }
    if isinstance(workflow_api_json, dict):
        summary["workflow_node_summary"] = summarize_workflow_api_json(workflow_api_json)
    else:
        summary["workflow_node_summary"] = []
    return summary


def collect_serverless_output_urls(result_payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(result_payload, dict):
        return []

    outputs = result_payload.get("outputs")
    if not isinstance(outputs, dict):
        return []

    urls: list[dict[str, Any]] = []
    for node_id, node_output in outputs.items():
        if not isinstance(node_output, dict):
            continue
        for channel_name, channel_items in node_output.items():
            if not isinstance(channel_items, list):
                continue
            for item in channel_items:
                if not isinstance(item, dict):
                    continue
                if "url" not in item:
                    continue
                urls.append(
                    {
                        "node_id": str(node_id),
                        "channel": channel_name,
                        "url": item.get("url"),
                        "filename": item.get("filename"),
                        "subfolder": item.get("subfolder"),
                        "type": item.get("type"),
                    }
                )
    return urls


def collect_model_output_urls(result_payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(result_payload, dict):
        return []
    return collect_urls(
        result_payload.get("output"),
        url_field_names=("url", "path", "image", "images", "video", "videos", "audio"),
    )


def collect_trainer_artifact_urls(result_payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(result_payload, dict):
        return []
    return collect_urls(result_payload.get("artifacts"), url_field_names=("path", "url"))


def collect_urls(
    value: Any,
    *,
    url_field_names: Iterable[str] = ("url", "path"),
    path: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    url_keys = set(url_field_names)
    collected: list[dict[str, Any]] = []

    if isinstance(value, dict):
        for key, nested_value in value.items():
            current_path = path + (str(key),)
            if key in url_keys and isinstance(nested_value, str) and _looks_like_url(nested_value):
                collected.append(
                    {
                        "field": key,
                        "json_path": ".".join(current_path),
                        "url": nested_value,
                    }
                )
            elif key in url_keys and isinstance(nested_value, list):
                for idx, item in enumerate(nested_value):
                    if isinstance(item, str) and _looks_like_url(item):
                        collected.append(
                            {
                                "field": key,
                                "json_path": f"{'.'.join(current_path)}.{idx}",
                                "url": item,
                            }
                        )
            else:
                collected.extend(
                    collect_urls(
                        nested_value,
                        url_field_names=url_field_names,
                        path=current_path,
                    )
                )
    elif isinstance(value, list):
        for index, item in enumerate(value):
            collected.extend(
                collect_urls(
                    item,
                    url_field_names=url_field_names,
                    path=path + (str(index),),
                )
            )

    return collected


def _looks_like_url(value: str) -> bool:
    return value.startswith("https://") or value.startswith("http://")
