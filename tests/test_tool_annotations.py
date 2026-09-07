from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from mcp.types import ListToolsResult


READ_ONLY_TOOLS = {
    "list_deployments", "get_deployment", "get_request_status", "get_request_result",
    "list_models", "list_model_categories", "get_model", "get_model_request_status",
    "get_model_request_result", "list_datasets", "get_training_job_status",
    "get_training_job_result", "get_balance",
}
NONDESTRUCTIVE_WRITES = {
    "create_dataset", "get_dataset_upload_urls", "get_dataset_status",
}
DESTRUCTIVE_TOOLS = {
    "create_deployment", "update_deployment", "delete_deployment", "submit_request",
    "cancel_request", "call_instance_proxy", "run_model", "cancel_model_request",
    "delete_dataset", "upload_dataset_file_from_url", "upload_dataset_text_file",
    "submit_training_job", "cancel_training_job", "resume_training_job", "edit_training_job",
}
OPEN_WORLD_TOOLS = {
    "submit_request", "cancel_request", "call_instance_proxy", "run_model",
    "delete_dataset", "upload_dataset_file_from_url", "upload_dataset_text_file",
    "submit_training_job", "resume_training_job",
}
IDEMPOTENT_TOOLS = READ_ONLY_TOOLS | {
    "get_dataset_status", "delete_deployment", "cancel_request", "cancel_model_request",
    "delete_dataset", "cancel_training_job",
}


class ExportedToolAnnotationTests(unittest.IsolatedAsyncioTestCase):
    """Validate serialized tools/list metadata, without credentials or API calls."""

    async def asyncSetUp(self) -> None:
        with (
            patch("dotenv.load_dotenv", return_value=False),
            patch("httpx.AsyncClient.request", side_effect=AssertionError("Metadata must not call an API")),
        ):
            import server

            exported = ListToolsResult(tools=await server.mcp.list_tools()).model_dump(
                mode="json", by_alias=True, exclude_none=True,
            )
        self.tools = {tool["name"]: tool for tool in exported["tools"]}
        self.assertEqual(len(exported["tools"]), len(self.tools), "Tool names must be unique")

    async def test_all_31_tools_export_explicit_submission_hints(self) -> None:
        expected = READ_ONLY_TOOLS | NONDESTRUCTIVE_WRITES | DESTRUCTIVE_TOOLS
        self.assertEqual(len(expected), 31)
        self.assertEqual(set(self.tools), expected)
        missing = [
            f"{name}.{hint}"
            for name, tool in self.tools.items()
            for hint in ("readOnlyHint", "destructiveHint", "openWorldHint")
            if type(tool.get("annotations", {}).get(hint)) is not bool
        ]
        self.assertEqual(missing, [], "Submission hints must survive tools/list serialization")

    async def test_read_only_excludes_readiness_reconciliation(self) -> None:
        self.assertEqual(self._enabled("readOnlyHint"), READ_ONLY_TOOLS)

    async def test_destructive_includes_overwrite_cancel_proxy_and_billable_compute(self) -> None:
        self.assertEqual(self._enabled("destructiveHint"), DESTRUCTIVE_TOOLS)

    async def test_open_world_matches_public_outputs_and_external_callbacks(self) -> None:
        self.assertEqual(self._enabled("openWorldHint"), OPEN_WORLD_TOOLS)

    async def test_existing_idempotency_guarantees_are_preserved(self) -> None:
        self.assertEqual(self._enabled("idempotentHint"), IDEMPOTENT_TOOLS)
        for name in set(self.tools) - IDEMPOTENT_TOOLS:
            self.assertNotIn("idempotentHint", self.tools[name]["annotations"])

    def _enabled(self, hint: str) -> set[str]:
        return {
            name for name, tool in self.tools.items()
            if tool.get("annotations", {}).get(hint) is True
        }


def tearDownModule() -> None:
    import server

    async def close_clients() -> None:
        await server.serverless_client.aclose()
        await server.model_client.aclose()
        await server.trainer_client.aclose()

    asyncio.run(close_clients())
