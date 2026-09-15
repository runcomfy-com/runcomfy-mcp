"""Bounded HTTP calls to the documented RunComfy APIs; no user-selected hosts."""

import json
import math
import re
from typing import Any

import httpx

HOSTS = {
    "model": "https://model-api.runcomfy.net",
    "workflow": "https://api.runcomfy.net",
    "training": "https://trainer-api.runcomfy.net",
}
MAX_INPUT_BYTES = 1_000_000


class RunComfyError(Exception):
    """Safe error suitable for a Dify tool result."""


def text(parameters: dict, key: str, *, maximum: int = 512) -> str:
    value = parameters.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RunComfyError(f"{key} is required.")
    value = value.strip()
    if len(value.encode("utf-8")) > maximum:
        raise RunComfyError(f"{key} exceeds the supported size.")
    return value


def identifier(parameters: dict, key: str, *, model: bool = False) -> str:
    value = text(parameters, key)
    pattern = r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*" if model else r"[A-Za-z0-9_-]+"
    if not re.fullmatch(pattern, value) or any(part in (".", "..") for part in value.split("/")):
        raise RunComfyError(f"{key} must be an API identifier, not a URL or path.")
    return value


def integer(parameters: dict, key: str, default: int, minimum: int, maximum: int) -> int:
    value = parameters.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value:
        raise RunComfyError(f"{key} must be an integer.")
    if not minimum <= value <= maximum:
        raise RunComfyError(f"{key} must be between {minimum} and {maximum}.")
    return int(value)


def json_object(parameters: dict, key: str) -> dict:
    value = text(parameters, key, maximum=MAX_INPUT_BYTES)
    try:
        result = json.loads(value, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, RecursionError):
        raise RunComfyError(f"{key} must contain valid JSON.") from None
    if not isinstance(result, dict):
        raise RunComfyError(f"{key} must contain a JSON object.")
    return result


def require_paid_authorization(parameters: dict) -> None:
    if parameters.get("allow_paid_run") is not True:
        raise RunComfyError("Enable Allow paid run in this tool's settings before creating a billable RunComfy job.")


class RunComfyClient:
    def __init__(self, api_key: str, *, transport: httpx.BaseTransport | None = None):
        if not isinstance(api_key, str) or not api_key.strip():
            raise RunComfyError("Configure your RunComfy API token in the plugin credentials.")
        self.api_key = api_key.strip()
        if not re.fullmatch(r"[\x21-\x7e]{1,4096}", self.api_key):
            raise RunComfyError("RunComfy API token contains unsupported characters or has an invalid length.")
        self.transport = transport

    def request(self, service: str, method: str, path: str, *, params=None, body=None) -> Any:
        if service not in HOSTS or not path.startswith("/") or path.startswith("//"):
            raise RunComfyError("Unsupported RunComfy endpoint.")
        try:
            # Never follow a redirect with the user's credential, retry a paid
            # submission, or use an ambient proxy configured on the worker.
            with httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0), follow_redirects=False,
                              trust_env=False, transport=self.transport) as client:
                response = client.request(method, HOSTS[service] + path, params=params, json=body,
                                          headers={"Authorization": f"Bearer {self.api_key}",
                                                   "Accept": "application/json"})
        except httpx.TimeoutException:
            hint = " Check your RunComfy dashboard before retrying; the job may have been accepted." if method == "POST" else " Try again later."
            raise RunComfyError("RunComfy request timed out." + hint) from None
        except httpx.RequestError:
            hint = " Check your RunComfy dashboard before retrying; the job may have been accepted." if method == "POST" else " Check service availability before retrying."
            raise RunComfyError("RunComfy connection failed." + hint) from None
        if response.status_code in (401, 403):
            raise RunComfyError("RunComfy rejected the API token or access to this resource.")
        if response.status_code == 402:
            raise RunComfyError("Your RunComfy account needs sufficient credit for this operation.")
        if response.status_code == 429:
            raise RunComfyError("RunComfy rate limit reached. Wait before trying again.")
        if not 200 <= response.status_code < 300:
            raise RunComfyError(f"RunComfy returned HTTP {response.status_code}. Check the input schema and job status in your account.")
        try:
            payload = response.json()
        except ValueError:
            hint = " Check your RunComfy dashboard before retrying; the job may have been accepted." if method == "POST" else ""
            raise RunComfyError("RunComfy returned an invalid JSON response." + hint) from None
        if isinstance(payload, dict) and payload.get("error_code") is not None:
            code = payload["error_code"]
            suffix = f" (code {code})" if isinstance(code, int) and not isinstance(code, bool) else ""
            raise RunComfyError("RunComfy rejected the request" + suffix + ". Check your inputs and account permissions.")
        if method == "POST":
            id_field = "id" if service == "training" else "request_id"
            job_id = payload.get(id_field) if isinstance(payload, dict) else None
            if not isinstance(job_id, str) or not job_id.strip():
                raise RunComfyError("RunComfy returned an invalid submission acknowledgment. Check your RunComfy dashboard before retrying; the job may have been accepted.")
        # Do not echo an API credential even if an upstream response reflects it.
        return self._redact(payload)

    def _redact(self, value: Any) -> Any:
        if isinstance(value, str):
            return value.replace(self.api_key, "[redacted]")
        if isinstance(value, list):
            return [self._redact(item) for item in value]
        if isinstance(value, dict):
            return {str(key).replace(self.api_key, "[redacted]"): self._redact(item) for key, item in value.items()}
        return value

    def run(self, operation: str, parameters: dict) -> Any:
        if operation == "list_models":
            params = {"limit": integer(parameters, "limit", 20, 1, 100),
                      "offset": integer(parameters, "offset", 0, 0, 100000)}
            for key in ("search", "category"):
                if parameters.get(key):
                    params[key] = text(parameters, key, maximum=200)
            return self.request("model", "GET", "/v1/models", params=params)
        if operation == "get_model":
            return self.request("model", "GET", "/v1/models/" + identifier(parameters, "model_id", model=True))
        if operation == "generate_media":
            require_paid_authorization(parameters)
            model_id = identifier(parameters, "model_id", model=True)
            body = json_object(parameters, "inputs_json")
            return self.request("model", "POST", "/v1/models/" + model_id, body=body)
        if operation == "list_deployments":
            return self.request("workflow", "GET", "/prod/v2/deployments")
        if operation == "get_deployment":
            return self.request("workflow", "GET", "/prod/v2/deployments/" + identifier(parameters, "deployment_id"),
                                params=[("includes", "payload"), ("includes", "readme")])
        if operation == "run_workflow":
            require_paid_authorization(parameters)
            deployment_id = identifier(parameters, "deployment_id")
            body = json_object(parameters, "request_json")
            if not set(body) <= {"overrides", "workflow_api_json", "extra_data"}:
                raise RunComfyError("request_json supports overrides, workflow_api_json, and extra_data only. Copy the deployment's documented payload.")
            for key, value in body.items():
                if not isinstance(value, dict):
                    raise RunComfyError(f"{key} must be a JSON object.")
            if body.get("workflow_api_json") and body.get("overrides"):
                raise RunComfyError("When sending workflow_api_json, omit overrides or keep it empty.")
            return self.request("workflow", "POST", f"/prod/v2/deployments/{deployment_id}/inference", body=body)
        if operation in ("get_job_status", "get_job_result"):
            service = parameters.get("service")
            job_id = identifier(parameters, "job_id")
            suffix = "status" if operation == "get_job_status" else "result"
            if service == "model":
                path = f"/v1/requests/{job_id}/{suffix}"
            elif service == "workflow":
                deployment_id = identifier(parameters, "deployment_id")
                path = f"/prod/v2/deployments/{deployment_id}/requests/{job_id}/{suffix}"
            elif service == "training":
                path = f"/prod/v1/trainers/ai-toolkit/jobs/{job_id}/{suffix}"
            else:
                raise RunComfyError("Choose model, workflow, or training as the service.")
            return self.request(service, "GET", path)
        if operation == "start_training":
            require_paid_authorization(parameters)
            config_file = text(parameters, "config_yaml", maximum=256000)
            gpu_type = parameters.get("gpu_type", "ADA_80_PLUS")
            if gpu_type not in ("ADA_80_PLUS", "HOPPER_141"):
                raise RunComfyError("Choose ADA_80_PLUS (H100) or HOPPER_141 (H200).")
            return self.request("training", "POST", "/prod/v1/trainers/ai-toolkit/jobs",
                                body={"config_file_format": "yaml", "config_file": config_file,
                                      "gpu_type": gpu_type, "gpu_count": 1})
        raise RunComfyError("Unsupported tool operation.")
