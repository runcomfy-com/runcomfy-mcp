import math
from typing import Any

from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError

from client import RunComfyClient, RunComfyError


class RunComfyProvider(ToolProvider):
    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        try:
            balance = RunComfyClient(credentials.get("api_key", "")).request("workflow", "GET", "/prod/v2/balance")
            if not isinstance(balance, dict) or balance.get("currency") != "USD":
                raise RunComfyError("RunComfy returned an unexpected balance response; credentials could not be verified.")
            for key in ("balance_microdollars", "balance_usd"):
                value = balance.get(key)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise RunComfyError("RunComfy returned an unexpected balance response; credentials could not be verified.")
        except RunComfyError as error:
            raise ToolProviderCredentialValidationError(str(error)) from None
