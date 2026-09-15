from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from client import RunComfyClient, RunComfyError


class RunComfyTool(Tool):
    operation: str

    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        try:
            data = RunComfyClient(self.runtime.credentials.get("api_key", "")).run(self.operation, tool_parameters)
        except RunComfyError as error:
            raise ValueError(str(error)) from None
        yield self.create_json_message(data if isinstance(data, dict) else {"data": data})
