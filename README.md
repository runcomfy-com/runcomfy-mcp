# RunComfy MCP

MCP server for the RunComfy platform — [Serverless API (ComfyUI)](https://docs.runcomfy.com/serverless/introduction), [Model API](https://docs.runcomfy.com/model-apis/quickstart), and [Trainer API](https://docs.runcomfy.com/trainer-apis/introduction). Manage deployments, run hosted models, train LoRAs, and retrieve results from AI assistants like Claude, Cursor, and Windsurf.

**Endpoint**: `https://mcp.runcomfy.com/mcp`

**Docs**: [docs.runcomfy.com/mcp](https://docs.runcomfy.com/mcp)

---

## What it does

31 tools mirroring the RunComfy docs 1:1, across three products plus your account balance.

### Serverless API (ComfyUI) — your own workflows on dedicated endpoints

Docs: [docs.runcomfy.com/serverless](https://docs.runcomfy.com/serverless)

| Category | Tools |
| --- | --- |
| **Deployment management** | `list_deployments`, `get_deployment`, `create_deployment`, `update_deployment`, `delete_deployment` |
| **Inference** | `submit_request`, `get_request_status`, `get_request_result`, `cancel_request` |
| **Advanced** | `call_instance_proxy` |

### Model API — hosted catalog models, on demand

Docs: [docs.runcomfy.com/model-apis](https://docs.runcomfy.com/model-apis/quickstart)

| Category | Tools |
| --- | --- |
| **Catalog** | `list_models`, `get_model`, `list_model_categories` |
| **Inference** | `run_model`, `get_model_request_status`, `get_model_request_result`, `cancel_model_request` |

No deployment to manage and per-request billing. `list_models` browses the
catalog by keyword or capability (`category=image-to-video`), `get_model`
returns one model's input schema — property types, defaults, enums, and
ranges — and `run_model` runs it. So an assistant can go from "make me a
video" to a valid request without leaving the tools or guessing a parameter.

Entries also carry `description`, `base_price_usd` per `price_unit`, and a
`model_url` to the model's page.

`model_id` is the identifier shown on the model's page at
[runcomfy.com/models](https://www.runcomfy.com/models), slashes included — e.g.
`blackforestlabs/flux-1-kontext/pro/edit`. File inputs must be public HTTPS URLs.

### Trainer API — datasets and AI Toolkit LoRA training

Docs: [docs.runcomfy.com/trainer-apis](https://docs.runcomfy.com/trainer-apis/introduction)

| Category | Tools |
| --- | --- |
| **Datasets** | `create_dataset`, `list_datasets`, `get_dataset_status`, `delete_dataset` |
| **Dataset uploads** | `upload_dataset_file_from_url`, `upload_dataset_text_file`, `get_dataset_upload_urls` |
| **Training jobs** | `submit_training_job`, `get_training_job_status`, `get_training_job_result`, `cancel_training_job`, `resume_training_job`, `edit_training_job` |

Typical flow: create a dataset → upload media and matching `.txt` captions →
poll until `READY` → submit a job with an AI Toolkit YAML config → poll status
→ pull checkpoints from the result.

Because the server runs remotely it cannot read local files. Upload media it
can reach over HTTP with `upload_dataset_file_from_url`, write captions inline
with `upload_dataset_text_file`, and for local or >150 MB files use
`get_dataset_upload_urls` and `PUT` the bytes to the signed URL yourself.

### Account

| Category | Tools |
| --- | --- |
| **Balance** | `get_balance` |

One wallet funds all three products. `get_balance` reports what is left, in
`balance_usd` for reading and `balance_microdollars` (millionths of a dollar)
for exact threshold checks. It is served from `api.runcomfy.net` rather than
mirrored per product, because there is only one figure to report.

### Crossing between them

A trained LoRA runs without any deployment: pass its base model's `model_id`
to `run_model` and the LoRA as an input, e.g.
`{"lora": {"path": "my_first_lora_3000.safetensors"}}` — either a name from
your [LoRA Assets](https://www.runcomfy.com/trainer/lora-assets) or a public
URL such as a checkpoint from `get_training_job_result`. For a dedicated
endpoint with chosen hardware, deploy it and use the Serverless tools instead.

---

## Quick setup

Every client authenticates with a RunComfy API token from your
[Profile](https://www.runcomfy.com/profile) page. Two ways to supply it:

- **API token header** — works in any Streamable HTTP client. Simplest, and the
  only option for clients without a browser OAuth flow.
- **Browser OAuth** — no token in a config file. Supported by Claude.ai and by
  local clients that register a loopback callback, such as Claude Code.

### Claude Code

Token header (one command, nothing else to do):

```bash
claude mcp add --transport http runcomfy https://mcp.runcomfy.com/mcp --header "Authorization: Bearer YOUR_RUNCOMFY_TOKEN"
```

Or browser OAuth — omit the header, then run `/mcp` inside Claude Code and pick
**Authenticate**:

```bash
claude mcp add --transport http runcomfy https://mcp.runcomfy.com/mcp
```

`--transport http` is the Streamable HTTP transport. `streamable-http` is not a
value Claude Code accepts, and single-dash `-transport` / `-header` are not
either — both forms fail before the server is ever contacted.

Check it with `claude mcp list`, which should show `runcomfy: connected`.

### Claude.ai

Add `https://mcp.runcomfy.com/mcp` in **Settings → Connectors → Add custom
connector**, then select **Connect**. Claude discovers RunComfy's OAuth 2.1
endpoints, opens a RunComfy consent page, and asks for one of the API tokens
shown in your [RunComfy Profile](https://www.runcomfy.com/profile). The token
is validated by RunComfy and encrypted inside the MCP authorization grant; it
is never returned to Claude.

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "runcomfy": {
      "url": "https://mcp.runcomfy.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_RUNCOMFY_TOKEN" }
    }
  }
}
```

### VS Code (Copilot)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "runcomfy": {
      "type": "http",
      "url": "https://mcp.runcomfy.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_RUNCOMFY_TOKEN" }
    }
  }
}
```

### Windsurf

**Settings → MCP**:

```json
{
  "mcpServers": {
    "runcomfy": {
      "serverUrl": "https://mcp.runcomfy.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_RUNCOMFY_TOKEN" }
    }
  }
}
```

### Any other client

- **URL**: `https://mcp.runcomfy.com/mcp`
- **Transport**: Streamable HTTP
- **Auth**: `Authorization: Bearer <token>` on every request, or OAuth 2.1 with
  a loopback redirect URI

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401` with `RunComfy rejected this API token` | The token is wrong, expired, or truncated on copy. Generate a new one in [Profile](https://www.runcomfy.com/profile) — the response body names the fix. |
| `401` with no `error_description` | No `Authorization` header reached the server. Check the header is quoted as one argument: `--header "Authorization: Bearer ..."`. |
| `invalid_client_metadata` during OAuth | The client registered a non-loopback, non-hosted redirect URI. Use the token header instead. |
| `invalid_target` during OAuth | The configured URL must be exactly `https://mcp.runcomfy.com/mcp` — no trailing slash. RFC 8707 binds the token to that exact resource. |
| `503` with `Retry-After` | RunComfy's API could not be reached to verify the token. Retry. |
| `429` | More than 600 token-authenticated requests a minute from one IP. |

Revoke access by regenerating the token in your RunComfy Profile. That
invalidates the token header and any OAuth grant built on it, because every MCP
request revalidates the token upstream.

---

## Architecture

```
MCP Client ──RunComfy API token──┐
                                 │   Cloudflare Worker (/mcp)
MCP Client ──MCP OAuth token─────┤   validates the credential, resolves
                                 │   it to one user's RunComfy token
                                 ▼
                         Cloudflare Container
                         (Python FastMCP app)
                                 │ request-scoped RunComfy credential
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
        api.runcomfy.net  model-api.       trainer-api.
         (Serverless)     runcomfy.net     runcomfy.net
                            (Model)          (Trainer)
```

One RunComfy token authenticates all three products, so the same credential
resolution covers every tool.

Both credential kinds converge on the same request-scoped identity header
before the container is reached. They are told apart by shape: OAuth access
tokens are always `userId:grantId:secret`, and a RunComfy API token never
contains a colon.

- **Cloudflare Worker** (`src/index.ts`) — OAuth 2.1 authorization server and protected-resource boundary. Missing, invalid, expired, or wrong-audience credentials are rejected before MCP initialization or tool discovery.
- **Direct API token** (`src/index.ts`) — a RunComfy Profile token presented as `Authorization: Bearer` is revalidated against `api.runcomfy.net` on every request, rate-limited per source IP, and never forwarded as-is.
- **OAuth consent** (`src/oauth-bridge.ts`) — validates an existing RunComfy Profile token, stores it only in encrypted OAuth grant data, and issues a separate audience-bound MCP access token. Dynamic client registration accepts loopback callbacks (Claude Code and other local clients) plus an exact allowlist of hosted client callbacks.
- **Python container** (`server.py`) — FastMCP app with 31 tools across the Serverless, Model, and Trainer APIs. It has no shared/operator credential and fails closed unless the authenticated edge supplies the current user's request-scoped RunComfy token.
- **Cloudflare Container** auto-starts on first request, sleeps after 10 minutes idle.

---

## Project layout

```
.github/workflows/deploy.yml  CI: typecheck, test, deploy to Cloudflare
src/index.ts          Cloudflare Worker entrypoint
src/oauth-bridge.ts   OAuth consent and RunComfy token validation
server.py             MCP tool definitions (31 tools)
runcomfy_client.py    RunComfy API clients (serverless, model, trainer)
container_app.py      ASGI middleware (request IDs, token forwarding)
container_entrypoint.py  Uvicorn startup
container_runtime.py  Env validation, structured logging
wrangler.jsonc        Cloudflare Worker + Container config
Dockerfile            Container image
.env.example          Local dev config
```

---

## Local development

```bash
# Python 3.11+
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m container_entrypoint
```

Local endpoints:
- `http://127.0.0.1:8000/healthz`
- `http://127.0.0.1:8000/mcp`

The local Python endpoint intentionally has no shared fallback credential.
Protected tool calls must go through the authenticated Worker boundary.

---

## Deploy

Pushing to `main` deploys automatically via `.github/workflows/deploy.yml`:
typecheck, Worker tests, and container tests must pass, then
`wrangler deploy --containers-rollout immediate` ships the Worker and the
Python container together. Pull requests run the same checks without
deploying. The workflow can also be run by hand from the Actions tab.

One repository secret is required:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A token with **Edit Cloudflare Workers** permission on the account in `wrangler.jsonc` |
| `CLOUDFLARE_ACCOUNT_ID` | Optional. `account_id` is already committed in `wrangler.jsonc`; set this only to deploy under a different account. |

To deploy by hand (requires Cloudflare Workers Paid plan with Containers enabled):

```bash
npm install
npm run check
npm test
npx wrangler deploy --containers-rollout immediate
```

The MCP endpoint goes live at `https://mcp.runcomfy.com/mcp` (custom domain configured in `wrangler.jsonc`).

---

## Environment variables and bindings

There is deliberately no shared RunComfy API-key secret. OAuth state is kept
in the `OAUTH_KV` binding and every upstream request is tied to the user who
authorized the OAuth grant.

### Worker vars (in `wrangler.jsonc`)

| Name | Default | Description |
| --- | --- | --- |
| `CONTAINER_INSTANCE_NAME` | `runcomfy-unified` | Durable Object instance name |
| `CONTAINER_STARTUP_TIMEOUT_MS` | `15000` | Max wait for container start |
| `CONTAINER_PORT_READY_TIMEOUT_MS` | `30000` | Max wait for port ready |
| `MCP_MAX_BODY_BYTES` | `1048576` | Max request body size |
| `OPENAI_APPS_CHALLENGE` | Current submission token | Public OpenAI domain-verification token, served verbatim at `GET /.well-known/openai-apps-challenge`; unset or empty returns 404. Verify ownership of any existing token before replacing it. |
| `MCP_DIRECT_TOKEN_RATE_LIMITER` | 600 / 60s | Per-IP cap on API-token-authenticated `/mcp` requests |
| `RUNCOMFY_SERVERLESS_BASE_URL` | `https://api.runcomfy.net` | Serverless API base URL |
| `RUNCOMFY_MODEL_API_BASE_URL` | `https://model-api.runcomfy.net` | Model API base URL |
| `RUNCOMFY_TRAINER_API_BASE_URL` | `https://trainer-api.runcomfy.net` | Trainer API base URL |

### Local Python dev (`.env` file)

| Name | Required | Description |
| --- | :---: | --- |
| `RUNCOMFY_SERVERLESS_BASE_URL` | No | Override Serverless base URL (default: `https://api.runcomfy.net`) |
| `RUNCOMFY_MODEL_API_BASE_URL` | No | Override Model API base URL (default: `https://model-api.runcomfy.net`) |
| `RUNCOMFY_TRAINER_API_BASE_URL` | No | Override Trainer API base URL (default: `https://trainer-api.runcomfy.net`) |
| `RUNCOMFY_MCP_MOUNT_PREFIX` | No | Path prefix for MCP mount (default: empty) |
