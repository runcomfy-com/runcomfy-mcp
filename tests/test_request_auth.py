from __future__ import annotations

import asyncio
import datetime
import json
import os
import subprocess
import sys
import unittest
from collections.abc import Awaitable, Callable
from unittest.mock import patch

from urllib.parse import parse_qsl, urlparse

import httpx

from container_app import RequestContextMiddleware
from container_runtime import validate_runtime_environment
from runcomfy_client import (
    BaseRunComfyClient,
    RunComfyAPIError,
    current_user_token,
)


class AuthenticatedRequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.requests: list[httpx.Request] = []
        self.client = BaseRunComfyClient(base_url="https://api.example.test")
        self.assertNotIn("authorization", self.client._client.headers)
        await self.client._client.aclose()

        async def handle(request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(0)
            self.requests.append(request)
            return httpx.Response(200, json={"ok": True})

        self.client._client = httpx.AsyncClient(
            base_url=self.client.base_url,
            headers={"Accept": "application/json"},
            transport=httpx.MockTransport(handle),
        )
        self.context_reset = current_user_token.set(None)

    async def asyncTearDown(self) -> None:
        current_user_token.reset(self.context_reset)
        await self.client.aclose()

    async def _request_with_token(self, token: str, path: str) -> None:
        reset = current_user_token.set(token)
        try:
            await self.client._request("GET", path)
        finally:
            current_user_token.reset(reset)

    async def test_missing_token_returns_401_before_network(self) -> None:
        with self.assertRaises(RunComfyAPIError) as raised:
            await self.client._request("GET", "/protected")

        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(self.requests, [])

    async def test_request_context_overwrites_explicit_authorization(self) -> None:
        reset = current_user_token.set("context-token")
        try:
            await self.client._request(
                "GET",
                "/protected",
                headers={"Authorization": "Bearer untrusted-token"},
            )
        finally:
            current_user_token.reset(reset)

        self.assertEqual(
            self.requests[0].headers["authorization"],
            "Bearer context-token",
        )

    async def test_sequential_tokens_do_not_fall_back_across_missing_context(self) -> None:
        await self._request_with_token("token-a", "/a")

        with self.assertRaises(RunComfyAPIError) as raised:
            await self.client._request("GET", "/missing")

        await self._request_with_token("token-b", "/b")

        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(
            [request.headers["authorization"] for request in self.requests],
            ["Bearer token-a", "Bearer token-b"],
        )

    async def test_concurrent_requests_keep_tokens_isolated(self) -> None:
        await asyncio.gather(
            self._request_with_token("token-a", "/a"),
            self._request_with_token("token-b", "/b"),
        )

        authorization_by_path = {
            request.url.path: request.headers["authorization"]
            for request in self.requests
        }
        self.assertEqual(
            authorization_by_path,
            {"/a": "Bearer token-a", "/b": "Bearer token-b"},
        )


class RequestContextMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def _invoke(
        self,
        app: Callable[..., Awaitable[None]],
        headers: list[tuple[bytes, bytes]],
    ) -> list[dict[str, object]]:
        messages: list[dict[str, object]] = []

        async def receive() -> dict[str, object]:
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message: dict[str, object]) -> None:
            messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "https",
            "path": "/mcp",
            "raw_path": b"/mcp",
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 1234),
            "server": ("container", 8000),
        }
        await RequestContextMiddleware(app)(scope, receive, send)
        return messages

    async def test_only_internal_header_sets_request_token_and_success_resets_it(self) -> None:
        observed: list[str | None] = []

        async def app(scope: object, receive: object, send: Callable[..., Awaitable[None]]) -> None:
            observed.append(current_user_token.get())
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        outer_reset = current_user_token.set("outer-context")
        try:
            await self._invoke(
                app,
                [
                    (b"authorization", b"Bearer public-token"),
                    (b"x-runcomfy-user-token", b"internal-token"),
                ],
            )
            self.assertEqual(current_user_token.get(), "outer-context")
        finally:
            current_user_token.reset(outer_reset)

        self.assertEqual(observed, ["internal-token"])

    async def test_public_authorization_header_is_not_an_identity_source(self) -> None:
        observed: list[str | None] = []

        async def app(scope: object, receive: object, send: Callable[..., Awaitable[None]]) -> None:
            observed.append(current_user_token.get())
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        await self._invoke(app, [(b"authorization", b"Bearer public-token")])

        self.assertEqual(observed, [None])
        self.assertIsNone(current_user_token.get())

    async def test_error_path_resets_request_token(self) -> None:
        observed: list[str | None] = []

        async def app(scope: object, receive: object, send: object) -> None:
            observed.append(current_user_token.get())
            raise RuntimeError("expected test failure")

        with self.assertRaisesRegex(RuntimeError, "expected test failure"):
            await self._invoke(
                app,
                [(b"x-runcomfy-user-token", b"internal-token")],
            )

        self.assertEqual(observed, ["internal-token"])
        self.assertIsNone(current_user_token.get())


class RuntimeConfigurationTests(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_runtime_does_not_require_shared_runcomfy_key(self) -> None:
        validate_runtime_environment()

    def test_server_imports_without_shared_runcomfy_keys(self) -> None:
        environment = os.environ.copy()
        environment.pop("RUNCOMFY_API_KEY", None)
        environment.pop("RUNCOMFY_SERVERLESS_API_KEY", None)
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import asyncio; import server; "
                    "asyncio.run(server.serverless_client.aclose()); "
                    "asyncio.run(server.model_client.aclose()); "
                    "asyncio.run(server.trainer_client.aclose())"
                ),
            ],
            cwd=os.path.dirname(os.path.dirname(__file__)),
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


def tearDownModule() -> None:
    import server

    asyncio.run(server.serverless_client.aclose())
    asyncio.run(server.model_client.aclose())
    asyncio.run(server.trainer_client.aclose())


if __name__ == "__main__":
    unittest.main()


class ToolResultShapeTests(unittest.TestCase):
    """structuredContent is optional in MCP and many clients ignore it.

    A tool that carries its payload only there looks, to those clients, like it
    returned nothing but a summary sentence -- which is how "list all my
    deployments" came back as a bare count of 54.
    """

    def test_ok_result_repeats_the_payload_in_content(self) -> None:
        from server import ok_result

        result = ok_result("Found 2 deployment(s).", {"deployments": [{"id": "a"}, {"id": "b"}]})

        self.assertEqual(result.content[0].text, "Found 2 deployment(s).")
        payload = json.loads(result.content[1].text)
        self.assertEqual(payload, result.structuredContent)
        self.assertEqual([d["id"] for d in payload["deployments"]], ["a", "b"])

    def test_error_result_repeats_the_payload_in_content(self) -> None:
        from server import error_result

        result = error_result("Nope.", data={"ok": False, "error": "Nope.", "status_code": 404})

        self.assertTrue(result.isError)
        payload = json.loads(result.content[1].text)
        self.assertEqual(payload, result.structuredContent)
        self.assertEqual(payload["status_code"], 404)

    def test_payload_text_survives_non_serializable_values(self) -> None:
        from server import ok_result

        result = ok_result("ok", {"when": datetime.datetime(2026, 1, 1)})

        self.assertIn("2026-01-01", result.content[1].text)


class ProductBaseUrlTests(unittest.TestCase):
    """Each RunComfy product is a separate host.

    A tool pointed at the wrong base URL fails in a confusing way (404 from a
    host that does not know the path), so pin the defaults.
    """

    def test_clients_target_their_documented_hosts(self) -> None:
        import server

        self.assertEqual(server.serverless_client.base_url, "https://api.runcomfy.net")
        self.assertEqual(server.model_client.base_url, "https://model-api.runcomfy.net")
        self.assertEqual(server.trainer_client.base_url, "https://trainer-api.runcomfy.net")


class ToolRoutingTests(unittest.IsolatedAsyncioTestCase):
    """Every tool must reach the endpoint the RunComfy docs name for it."""

    async def asyncSetUp(self) -> None:
        import server

        self.server = server
        self.seen: list[tuple[str, str, bytes, str]] = []
        self.originals = {
            name: getattr(server, name)._client
            for name in ("serverless_client", "model_client", "trainer_client")
        }

        async def handle(request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(0)
            self.seen.append(
                (request.method, request.url.path, request.content, str(request.url))
            )
            return httpx.Response(
                200,
                json={"id": "x", "status": "READY", "models": [], "total": 0},
            )

        for name in self.originals:
            client = getattr(server, name)
            client._client = httpx.AsyncClient(
                base_url=client.base_url,
                headers={"Accept": "application/json"},
                transport=httpx.MockTransport(handle),
            )
        self.context_reset = current_user_token.set("tok_routing")

    async def asyncTearDown(self) -> None:
        current_user_token.reset(self.context_reset)
        for name, original in self.originals.items():
            client = getattr(self.server, name)
            await client._client.aclose()
            client._client = original

    def assert_called(self, method: str, path: str) -> None:
        self.assertIn(
            (method, path),
            [(m, p) for m, p, _, _ in self.seen],
            f"expected {method} {path}, saw {[(m, p) for m, p, _, _ in self.seen]}",
        )

    def last_query(self) -> dict[str, str]:
        return dict(parse_qsl(urlparse(self.seen[-1][3]).query))

    def last_origin(self) -> str:
        parts = urlparse(self.seen[-1][3])
        return f"{parts.scheme}://{parts.netloc}"

    async def test_catalog_tools_hit_the_model_api(self) -> None:
        await self.server.list_models(
            search="kontext", category="image-to-image", kind="model", limit=5, offset=10
        )
        self.assert_called("GET", "/v1/models")
        query = self.last_query()
        self.assertEqual(query["search"], "kontext")
        self.assertEqual(query["category"], "image-to-image")
        self.assertEqual(query["kind"], "model")
        self.assertEqual(query["limit"], "5")
        self.assertEqual(query["offset"], "10")
        # Schemas are heavy, so the flag is only sent when asked for.
        self.assertNotIn("include_schema", query)

        await self.server.list_models(include_schema=True)
        self.assertEqual(self.last_query()["include_schema"], "true")

        await self.server.list_model_categories()
        self.assert_called("GET", "/v1/models/categories")

        await self.server.get_model(model_id="blackforestlabs/flux-1-kontext/pro/edit")
        # Slashes in a model_id are path segments, not something to escape.
        self.assert_called("GET", "/v1/models/blackforestlabs/flux-1-kontext/pro/edit")

    async def test_balance_hits_the_core_api(self) -> None:
        """One wallet, so balance lives on the core API host, not per product."""
        await self.server.get_balance()

        self.assert_called("GET", "/prod/v2/balance")
        self.assertEqual(self.last_origin(), self.server.serverless_client.base_url)

    async def test_model_tools_hit_the_model_api(self) -> None:
        await self.server.run_model(model_id="blackforestlabs/flux-1-kontext/pro/edit")
        # Slashes in a model_id are path segments, not something to escape.
        self.assert_called("POST", "/v1/models/blackforestlabs/flux-1-kontext/pro/edit")

        await self.server.get_model_request_status(request_id="req_1")
        self.assert_called("GET", "/v1/requests/req_1/status")

        await self.server.get_model_request_result(request_id="req_1")
        self.assert_called("GET", "/v1/requests/req_1/result")

        await self.server.cancel_model_request(request_id="req_1")
        self.assert_called("POST", "/v1/requests/req_1/cancel")

    async def test_dataset_tools_hit_the_trainer_api(self) -> None:
        await self.server.create_dataset(name="dogs")
        self.assert_called("POST", "/prod/v1/trainers/datasets")

        await self.server.list_datasets()
        self.assert_called("GET", "/prod/v1/trainers/datasets")

        await self.server.get_dataset_status(dataset_id="ds_1")
        self.assert_called("GET", "/prod/v1/trainers/datasets/ds_1/status")

        await self.server.upload_dataset_text_file(
            dataset_id="ds_1", filename="img_0001.txt", text="a dog"
        )
        self.assert_called("POST", "/prod/v1/trainers/datasets/ds_1/upload")

        await self.server.get_dataset_upload_urls(
            dataset_id="ds_1", filename_to_byte_size={"clip.mp4": 200_000_000}
        )
        self.assert_called(
            "POST", "/prod/v1/trainers/datasets/ds_1/get-upload-endpoint"
        )

        await self.server.delete_dataset(dataset_id="ds_1")
        self.assert_called("DELETE", "/prod/v1/trainers/datasets/ds_1")

    async def test_training_job_tools_hit_the_trainer_api(self) -> None:
        await self.server.submit_training_job(
            config_file="job: extension\n", gpu_type="ADA_80_PLUS"
        )
        self.assert_called("POST", "/prod/v1/trainers/ai-toolkit/jobs")
        body = json.loads(self.seen[-1][2])
        self.assertEqual(body["config_file_format"], "yaml")
        self.assertEqual(body["gpu_type"], "ADA_80_PLUS")

        await self.server.get_training_job_status(job_id="job_1")
        self.assert_called("GET", "/prod/v1/trainers/ai-toolkit/jobs/job_1/status")

        await self.server.get_training_job_result(job_id="job_1")
        self.assert_called("GET", "/prod/v1/trainers/ai-toolkit/jobs/job_1/result")

        await self.server.cancel_training_job(job_id="job_1")
        self.assert_called("POST", "/prod/v1/trainers/ai-toolkit/jobs/job_1/cancel")

        await self.server.resume_training_job(job_id="job_1")
        self.assert_called("POST", "/prod/v1/trainers/ai-toolkit/jobs/job_1/resume")

        await self.server.edit_training_job(job_id="job_1", config_file="job: extension\n")
        self.assert_called("POST", "/prod/v1/trainers/ai-toolkit/jobs/job_1/edit")

    async def test_rejected_arguments_never_reach_the_network(self) -> None:
        rejected = [
            self.server.submit_training_job(config_file="x", gpu_type="AMPERE_48"),
            self.server.submit_training_job(
                config_file="x", gpu_type="HOPPER_141", gpu_count=8
            ),
            self.server.submit_training_job(config_file="   "),
            self.server.edit_training_job(job_id="job_1", config_file=" "),
            self.server.run_model(model_id="  /  "),
            self.server.get_model(model_id="  /  "),
            self.server.list_models(limit=0),
            self.server.list_models(limit=501),
            self.server.list_models(offset=-1),
            self.server.get_dataset_upload_urls(
                dataset_id="ds_1", filename_to_byte_size={}
            ),
            self.server.get_dataset_upload_urls(
                dataset_id="ds_1", filename_to_byte_size={"a.jpg": 0}
            ),
            # A local path is not something the container can read; it must not
            # be sent upstream as if it were a fetchable URL.
            self.server.upload_dataset_file_from_url(
                dataset_id="ds_1", source_url="/Users/me/dog.jpg"
            ),
        ]
        for coro in rejected:
            result = await coro
            self.assertTrue(result.isError, result.content[0].text)
        self.assertEqual(self.seen, [])


class UnauthenticatedToolTests(unittest.IsolatedAsyncioTestCase):
    """No shared operator credential exists, so tools must fail closed."""

    async def test_every_product_refuses_without_a_request_scoped_token(self) -> None:
        import server

        reset = current_user_token.set(None)
        try:
            for coro in (
                server.list_deployments(),
                server.run_model(model_id="some/model"),
                server.list_datasets(),
                server.get_training_job_status(job_id="job_1"),
                server.list_models(),
                server.get_balance(),
            ):
                result = await coro
                self.assertTrue(result.isError)
                self.assertEqual(result.structuredContent["status_code"], 401)
        finally:
            current_user_token.reset(reset)
