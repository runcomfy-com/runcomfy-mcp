# RunComfy MCP

[![Website](https://img.shields.io/badge/Website-www.runcomfy.com-6C47FF)](https://www.runcomfy.com)
[![Docs](https://img.shields.io/badge/Docs-MCP-2965F1)](https://docs.runcomfy.com/mcp)

MCP server for the [RunComfy Serverless API (ComfyUI)](https://docs.runcomfy.com/serverless/introduction). Manage deployments, run inference, and retrieve results from AI assistants like Claude, Cursor, and Windsurf.

**Website**: [www.runcomfy.com](https://www.runcomfy.com)

**Endpoint**: `https://mcp.runcomfy.com/mcp`

**Docs**: [docs.runcomfy.com/mcp](https://docs.runcomfy.com/mcp)

---

## What it does

10 tools that mirror [docs.runcomfy.com/serverless](https://docs.runcomfy.com/serverless) 1:1:

| Category | Tools |
| --- | --- |
| **Deployment management** | `list_deployments`, `get_deployment`, `create_deployment`, `update_deployment`, `delete_deployment` |
| **Inference** | `submit_request`, `get_request_status`, `get_request_result`, `cancel_request` |
| **Advanced** | `call_instance_proxy` |

---

## Quick setup

### Claude Code

```bash
claude mcp add runcomfy \
  --transport streamable-http \
  https://mcp.runcomfy.com/mcp \
  --header "Authorization: Bearer <YOUR_RUNCOMFY_TOKEN>"
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "runcomfy": {
      "url": "https://mcp.runcomfy.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_RUNCOMFY_TOKEN>"
      }
    }
  }
}
```

### Windsurf

Add to Windsurf Settings > MCP:

```json
{
  "mcpServers": {
    "runcomfy": {
      "serverUrl": "https://mcp.runcomfy.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_RUNCOMFY_TOKEN>"
      }
    }
  }
}
```

Get your API token from your [Profile](https://www.runcomfy.com/profile) page.

---

## Architecture

```
MCP Client  ──Bearer token──>  Cloudflare Worker (/mcp)
                                      │
                                      ▼
                              Cloudflare Container
                              (Python FastMCP app)
                                      │
                                      ▼
                              api.runcomfy.net
                              (using caller's token)
```

- **Cloudflare Worker** (`src/index.ts`) — thin proxy: CORS, body size check, forwards the caller's token to the container. No auth logic — `api.runcomfy.net` handles authentication.
- **Python container** (`server.py`) — FastMCP app with 10 tools. Uses the caller's token (forwarded via `x-runcomfy-user-token` header) for all outbound API calls. Each user sees only their own deployments.
- **Cloudflare Container** auto-starts on first request, sleeps after 10 minutes idle.

---

## Project layout

```
src/index.ts          Cloudflare Worker entrypoint
server.py             MCP tool definitions (10 tools)
runcomfy_client.py    RunComfy API client (serverless endpoints)
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
# Set RUNCOMFY_API_KEY in .env
python -m container_entrypoint
```

Local endpoints:
- `http://127.0.0.1:8000/healthz`
- `http://127.0.0.1:8000/mcp`

In local mode (no Worker), the Python app uses `RUNCOMFY_API_KEY` from `.env` for all outbound calls.

---

## Deploy

Requires Cloudflare Workers Paid plan with Containers enabled.

```bash
npm install

# Set the API key secret (one-time)
npx wrangler secret put RUNCOMFY_API_KEY

# Deploy
CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler deploy
```

The MCP endpoint goes live at `https://mcp.runcomfy.com/mcp` (custom domain configured in `wrangler.jsonc`).

---

## Environment variables

### Worker secrets (set via `wrangler secret put`)

| Name | Required | Description |
| --- | :---: | --- |
| `RUNCOMFY_API_KEY` | Yes | Fallback API key for the container |

### Worker vars (in `wrangler.jsonc`)

| Name | Default | Description |
| --- | --- | --- |
| `CONTAINER_INSTANCE_NAME` | `runcomfy-unified` | Durable Object instance name |
| `CONTAINER_STARTUP_TIMEOUT_MS` | `15000` | Max wait for container start |
| `CONTAINER_PORT_READY_TIMEOUT_MS` | `30000` | Max wait for port ready |
| `MCP_MAX_BODY_BYTES` | `1048576` | Max request body size |
| `RUNCOMFY_SERVERLESS_BASE_URL` | `https://api.runcomfy.net` | Serverless API base URL |

### Local dev (`.env` file)

| Name | Required | Description |
| --- | :---: | --- |
| `RUNCOMFY_API_KEY` | Yes | Your RunComfy API token |
| `RUNCOMFY_SERVERLESS_BASE_URL` | No | Override base URL (default: `https://api.runcomfy.net`) |
| `RUNCOMFY_MCP_MOUNT_PREFIX` | No | Path prefix for MCP mount (default: empty) |
