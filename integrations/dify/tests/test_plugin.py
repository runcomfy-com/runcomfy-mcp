import importlib
import json
from pathlib import Path

import dify_plugin  # Initialize the SDK's networking runtime before importing HTTP clients.
import httpx
import pytest
import yaml

from client import RunComfyClient, RunComfyError


@pytest.fixture
def calls():
    return []


@pytest.fixture
def api(calls):
    def respond(request):
        calls.append(request)
        id_field = "id" if request.url.host == "trainer-api.runcomfy.net" else "request_id"
        return httpx.Response(200, json={id_field: "job-123", "status": "queued"})
    return RunComfyClient("unit-test-only", transport=httpx.MockTransport(respond))


@pytest.mark.parametrize("operation,params,method,url,body", [
    ("list_models", {"search": "wan", "limit": 5, "offset": 10}, "GET", "https://model-api.runcomfy.net/v1/models?limit=5&offset=10&search=wan", None),
    ("get_model", {"model_id": "acme/flux-2/text-to-image"}, "GET", "https://model-api.runcomfy.net/v1/models/acme/flux-2/text-to-image", None),
    ("generate_media", {"allow_paid_run": True, "model_id": "acme/video", "inputs_json": '{"prompt":"hello","duration":5}'}, "POST", "https://model-api.runcomfy.net/v1/models/acme/video", {"prompt": "hello", "duration": 5}),
    ("list_deployments", {}, "GET", "https://api.runcomfy.net/prod/v2/deployments", None),
    ("get_deployment", {"deployment_id": "dep-123"}, "GET", "https://api.runcomfy.net/prod/v2/deployments/dep-123?includes=payload&includes=readme", None),
    ("run_workflow", {"allow_paid_run": True, "deployment_id": "dep-123", "request_json": '{"overrides":{"6":{"inputs":{"text":"hello"}}}}'}, "POST", "https://api.runcomfy.net/prod/v2/deployments/dep-123/inference", {"overrides": {"6": {"inputs": {"text": "hello"}}}}),
    ("start_training", {"allow_paid_run": True, "config_yaml": "job: extension\nconfig:\n  name: test", "gpu_type": "HOPPER_141"}, "POST", "https://trainer-api.runcomfy.net/prod/v1/trainers/ai-toolkit/jobs", {"config_file_format": "yaml", "config_file": "job: extension\nconfig:\n  name: test", "gpu_type": "HOPPER_141", "gpu_count": 1}),
])
def test_api_contract(api, calls, operation, params, method, url, body):
    id_field = "id" if operation == "start_training" else "request_id"
    assert api.run(operation, params)[id_field] == "job-123"
    assert len(calls) == 1
    request = calls[0]
    assert request.method == method
    assert str(request.url) == url
    assert request.headers["Authorization"] == "Bearer unit-test-only"
    assert (json.loads(request.content) if request.content else None) == body


@pytest.mark.parametrize("service,prefix", [
    ("model", "https://model-api.runcomfy.net/v1/requests/job-123"),
    ("workflow", "https://api.runcomfy.net/prod/v2/deployments/dep-123/requests/job-123"),
    ("training", "https://trainer-api.runcomfy.net/prod/v1/trainers/ai-toolkit/jobs/job-123"),
])
@pytest.mark.parametrize("operation,suffix", [("get_job_status", "status"), ("get_job_result", "result")])
def test_job_service_routing(api, calls, service, prefix, operation, suffix):
    api.run(operation, {"service": service, "job_id": "job-123", "deployment_id": "dep-123"})
    assert len(calls) == 1
    assert str(calls[0].url) == f"{prefix}/{suffix}"
    assert calls[0].method == "GET"


@pytest.mark.parametrize("operation", ["generate_media", "run_workflow", "start_training"])
@pytest.mark.parametrize("authorization", [None, False, "true", 1])
def test_paid_actions_need_explicit_boolean(api, calls, operation, authorization):
    with pytest.raises(RunComfyError, match="Allow paid run"):
        api.run(operation, {"allow_paid_run": authorization})
    assert calls == []


@pytest.mark.parametrize("bad_id", ["https://attacker.invalid", "//attacker.invalid", "a/../b", "..", "a/%2e%2e/b", "a?key=x", "a#fragment", "a\\b", "a\nb"])
def test_model_route_cannot_escape(api, calls, bad_id):
    with pytest.raises(RunComfyError):
        api.run("get_model", {"model_id": bad_id})
    assert calls == []


@pytest.mark.parametrize("body", ["[]", "null", "{broken}", '{"x":NaN}', '{"x":Infinity}', '"hello"'])
def test_invalid_inputs_are_rejected_before_network(api, calls, body):
    with pytest.raises(RunComfyError):
        api.run("generate_media", {"allow_paid_run": True, "model_id": "a/b", "inputs_json": body})
    assert calls == []


@pytest.mark.parametrize("body", ['{"webhook":"https://attacker.invalid"}', '{"overrides":[]}', '{"overrides":{"6":{}},"workflow_api_json":{"7":{}}}'])
def test_workflow_payload_shape(api, calls, body):
    with pytest.raises(RunComfyError):
        api.run("run_workflow", {"allow_paid_run": True, "deployment_id": "dep", "request_json": body})
    assert calls == []


@pytest.mark.parametrize("code", [301, 302, 307, 400, 401, 402, 403, 404, 429, 500])
def test_api_errors_do_not_leak_details_or_follow_redirects(code):
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(code, text="Bearer private-example", headers={"Location": "https://attacker.invalid"})
    api = RunComfyClient("private-example", transport=httpx.MockTransport(respond))
    with pytest.raises(RunComfyError) as error:
        api.run("list_models", {})
    assert "private-example" not in str(error.value)
    assert "attacker" not in str(error.value)
    assert len(calls) == 1


def test_timeout_warns_of_accepted_paid_job_without_retry():
    calls = []
    def respond(request):
        calls.append(request)
        raise httpx.ReadTimeout("private-example", request=request)
    api = RunComfyClient("private-example", transport=httpx.MockTransport(respond))
    with pytest.raises(RunComfyError, match="may have been accepted") as error:
        api.run("generate_media", {"allow_paid_run": True, "model_id": "a/b", "inputs_json": '{}'})
    assert "private-example" not in str(error.value)
    assert len(calls) == 1


def test_body_level_error():
    api = RunComfyClient("unit-test-only", transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"error_code": 403003, "error_message": "private body"})))
    with pytest.raises(RunComfyError, match="403003") as error:
        api.run("list_models", {})
    assert "private body" not in str(error.value)


def test_reflected_token_is_redacted():
    api = RunComfyClient("unit-test-only", transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"items": [{"text": "Bearer unit-test-only"}]})))
    assert api.run("list_models", {}) == {"items": [{"text": "Bearer [redacted]"}]}


@pytest.mark.parametrize("value", [0, 101, 1.5, "5", True, float("nan"), float("inf")])
def test_list_limit_bounds(api, calls, value):
    with pytest.raises(RunComfyError):
        api.run("list_models", {"limit": value})
    assert calls == []


def test_input_size_limit(api, calls):
    with pytest.raises(RunComfyError, match="size"):
        api.run("generate_media", {"allow_paid_run": True, "model_id": "a/b", "inputs_json": '{"prompt":"' + "x" * 1_000_000 + '"}'})
    assert calls == []


@pytest.mark.parametrize("token", ["a\nb", "a\rb", "a b", "测试", "x" * 4097])
def test_invalid_token_characters_are_rejected(token):
    with pytest.raises(RunComfyError):
        RunComfyClient(token)


def test_connection_loss_has_uncertain_submission_warning():
    calls = []
    def respond(request):
        calls.append(request)
        raise httpx.RemoteProtocolError("response lost", request=request)
    api = RunComfyClient("unit-test-only", transport=httpx.MockTransport(respond))
    with pytest.raises(RunComfyError, match="may have been accepted"):
        api.run("start_training", {"allow_paid_run": True, "config_yaml": "job: extension"})
    assert len(calls) == 1


def test_dify_tool_registration_and_outputs(monkeypatch):
    import runtime
    provider = yaml.safe_load(Path("provider/runcomfy.yaml").read_text())
    seen = []
    monkeypatch.setattr(runtime.RunComfyClient, "run", lambda self, name, params: seen.append(name) or {"ok": True})
    for definition in provider["tools"]:
        metadata = yaml.safe_load(Path(definition).read_text())
        name = metadata["identity"]["name"]
        module = importlib.import_module("tools." + name)
        cls = getattr(module, "".join(part.title() for part in name.split("_")) + "Tool")
        tool = cls.from_credentials({"api_key": "unit-test-only"})
        messages = list(tool.invoke({}))
        assert messages[0].message.json_object == {"ok": True}
        assert seen[-1] == name
    assert len(seen) == 9


def test_dify_provider_uses_read_only_balance(monkeypatch):
    from provider.runcomfy import RunComfyProvider
    calls = []
    monkeypatch.setattr(RunComfyClient, "request", lambda self, *args: calls.append(args) or {"balance_usd": 0, "balance_microdollars": 0, "currency": "USD"})
    RunComfyProvider()._validate_credentials({"api_key": "unit-test-only"})
    assert calls == [("workflow", "GET", "/prod/v2/balance")]


@pytest.mark.parametrize("balance", [0, -1.2, 4.83])
def test_zero_and_negative_balances_validate_credentials(monkeypatch, balance):
    from provider.runcomfy import RunComfyProvider
    monkeypatch.setattr(RunComfyClient, "request", lambda *args: {"balance_usd": balance, "balance_microdollars": int(balance * 1_000_000), "currency": "USD"})
    RunComfyProvider()._validate_credentials({"api_key": "unit-test-only"})


@pytest.mark.parametrize("payload", [{}, [], None, {"currency": "USD"}, {"currency": "USD", "balance_usd": True, "balance_microdollars": 1}, {"currency": "USD", "balance_usd": float("nan"), "balance_microdollars": 1}])
def test_malformed_balance_cannot_validate_credentials(monkeypatch, payload):
    from provider.runcomfy import RunComfyProvider
    from dify_plugin.errors.tool import ToolProviderCredentialValidationError
    monkeypatch.setattr(RunComfyClient, "request", lambda *args: payload)
    with pytest.raises(ToolProviderCredentialValidationError, match="could not be verified"):
        RunComfyProvider()._validate_credentials({"api_key": "unit-test-only"})


def test_workflow_with_saved_defaults(api, calls):
    api.run("run_workflow", {"deployment_id": "dep", "allow_paid_run": True, "request_json": "{}"})
    assert json.loads(calls[0].content) == {}
    assert str(calls[0].url) == "https://api.runcomfy.net/prod/v2/deployments/dep/inference"


@pytest.mark.parametrize("operation,parameters,id_field", [
    ("generate_media", {"model_id": "a/b", "inputs_json": "{}"}, "request_id"),
    ("run_workflow", {"deployment_id": "dep", "request_json": "{}"}, "request_id"),
    ("start_training", {"config_yaml": "job: extension"}, "id"),
])
@pytest.mark.parametrize("acknowledgment", ["empty", "null", "list", "missing", "blank", "whitespace", "numeric", "wrong_id_field", "invalid_json"])
def test_malformed_paid_acknowledgments_are_uncertain_without_retry(operation, parameters, id_field, acknowledgment):
    payloads = {
        "empty": {}, "null": None, "list": [{id_field: "job-123"}],
        "missing": {"status": "queued"}, "blank": {id_field: ""},
        "whitespace": {id_field: "  "}, "numeric": {id_field: 123},
        "wrong_id_field": {"request_id" if id_field == "id" else "id": "job-123"},
    }
    calls = []
    def respond(request):
        calls.append(request)
        content = "not-json" if acknowledgment == "invalid_json" else json.dumps(payloads[acknowledgment])
        return httpx.Response(200, text=content)
    api = RunComfyClient("unit-test-only", transport=httpx.MockTransport(respond))
    with pytest.raises(RunComfyError, match="Check your RunComfy dashboard before retrying; the job may have been accepted"):
        api.run(operation, {**parameters, "allow_paid_run": True})
    assert len(calls) == 1
