import { Container, getContainer } from "@cloudflare/containers";

const CONTAINER_PORT = 8000;
const DEFAULT_CONTAINER_INSTANCE_NAME = "runcomfy-unified";
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_PORT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_INTERVAL_MS = 300;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface Env {
  RUNCOMFY_MCP_CONTAINER: DurableObjectNamespace<RuncomfyMcpContainer>;
  RUNCOMFY_API_KEY: string;
  CONTAINER_INSTANCE_NAME?: string;
  CONTAINER_STARTUP_TIMEOUT_MS?: string;
  CONTAINER_PORT_READY_TIMEOUT_MS?: string;
  CONTAINER_WAIT_INTERVAL_MS?: string;
  MCP_MAX_BODY_BYTES?: string;
  RUNCOMFY_SERVERLESS_BASE_URL?: string;
  RUNCOMFY_SERVERLESS_API_KEY?: string;
}

function log(level: string, event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, service: "runcomfy-mcp-worker", ...data });
  if (level === "error") console.error(line);
  else console.log(line);
}

function toErrorDetails(error: unknown): { type: string; message: string } {
  if (error instanceof Error) return { type: error.name, message: error.message };
  return { type: "Error", message: String(error) };
}

function optionalInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildCorsHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, HEAD, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, accept, x-mcp-secret, x-request-id, mcp-session-id, last-event-id",
    "access-control-expose-headers": "x-request-id",
    vary: "origin",
  });
}

function jsonResponse(body: Record<string, unknown>, status: number, requestId: string): Response {
  const headers = buildCorsHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-request-id", requestId);
  return new Response(JSON.stringify(body), { status, headers });
}

function finalizeResponse(response: Response, requestId: string): Response {
  const headers = buildCorsHeaders();
  for (const [key, value] of response.headers.entries()) {
    headers.set(key, value);
  }
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getRequestId(request: Request): string {
  return request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.replace(/\/+$/, "")
    : pathname;
}

// Extract the Bearer token (or x-mcp-secret) from the request and forward
// it as x-runcomfy-user-token so the Python layer can use it for outbound
// API calls. The token is NOT validated here — api.runcomfy.net handles auth.
function buildForwardedRequest(request: Request, requestId: string): Request {
  const headers = new Headers(request.headers);
  const url = new URL(request.url);

  // Extract raw token before stripping auth headers
  let rawToken = "";
  const authHeader = headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    rawToken = authHeader.slice("Bearer ".length).trim();
  }
  if (!rawToken) {
    rawToken = headers.get("x-mcp-secret")?.trim() || "";
  }

  headers.delete("authorization");
  headers.delete("x-mcp-secret");
  if (rawToken) {
    headers.set("x-runcomfy-user-token", rawToken);
  }
  headers.set("x-request-id", requestId);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set("x-forwarded-host", url.host);
  // Rewrite Host to the container's internal address so Uvicorn/Starlette
  // doesn't reject it as an unknown host.
  headers.set("host", `localhost:${CONTAINER_PORT}`);

  const normalized = normalizePathname(url.pathname);
  if (normalized !== url.pathname) {
    url.pathname = normalized;
    return new Request(url.toString(), new Request(request, { headers }));
  }
  return new Request(request, { headers });
}

export class RuncomfyMcpContainer extends Container<Env> {
  defaultPort = CONTAINER_PORT;
  requiredPorts = [CONTAINER_PORT];
  sleepAfter = "10m";
  enableInternet = true;
  pingEndpoint = "localhost/healthz";

  override async fetch(request: Request): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const start = Date.now();

    try {
      await this.startAndWaitForPorts({
        ports: CONTAINER_PORT,
        startOptions: {
          envVars: {
            PORT: String(CONTAINER_PORT),
            RUNCOMFY_API_KEY: this.env.RUNCOMFY_API_KEY,
            RUNCOMFY_MCP_MOUNT_PREFIX: "",
            ...(this.env.RUNCOMFY_SERVERLESS_BASE_URL
              ? { RUNCOMFY_SERVERLESS_BASE_URL: this.env.RUNCOMFY_SERVERLESS_BASE_URL }
              : {}),
            ...(this.env.RUNCOMFY_SERVERLESS_API_KEY
              ? { RUNCOMFY_SERVERLESS_API_KEY: this.env.RUNCOMFY_SERVERLESS_API_KEY }
              : {}),
          },
          entrypoint: ["python", "-m", "container_entrypoint"],
          enableInternet: true,
        },
        cancellationOptions: {
          instanceGetTimeoutMS: optionalInt(this.env.CONTAINER_STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS),
          portReadyTimeoutMS: optionalInt(this.env.CONTAINER_PORT_READY_TIMEOUT_MS, DEFAULT_PORT_READY_TIMEOUT_MS),
          waitInterval: optionalInt(this.env.CONTAINER_WAIT_INTERVAL_MS, DEFAULT_WAIT_INTERVAL_MS),
        },
      });

      // Rewrite the request URL to the container's internal address.
      // containerFetch uses the request's URL host, and the external
      // domain causes a 421 Misdirected Request.
      const internalUrl = new URL(request.url);
      internalUrl.protocol = "http:";
      internalUrl.hostname = "localhost";
      internalUrl.port = String(CONTAINER_PORT);
      const internalRequest = new Request(internalUrl.toString(), request);
      const response = await this.containerFetch(internalRequest, CONTAINER_PORT);
      return finalizeResponse(response, requestId);
    } catch (error) {
      log("error", "container.proxy.error", {
        requestId,
        durationMs: Date.now() - start,
        error: toErrorDetails(error),
      });
      return jsonResponse(
        { ok: false, error: "Failed to reach MCP container", detail: toErrorDetails(error).message },
        502,
        requestId,
      );
    }
  }

  override onStart(): void {
    log("info", "container.started");
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    log("warn", "container.stopped", { exitCode, reason });
  }

  override onError(error: unknown): never {
    log("error", "container.lifecycle.error", { error: toErrorDetails(error) });
    throw error;
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const requestId = getRequestId(request);
    const url = new URL(request.url);
    const pathname = normalizePathname(url.pathname);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS" && (pathname === "/healthz" || pathname === "/mcp")) {
      const headers = buildCorsHeaders();
      headers.set("x-request-id", requestId);
      return new Response(null, { status: 204, headers });
    }

    // Health check (no auth, no container)
    if (pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
      return jsonResponse({ ok: true, service: "runcomfy-mcp-worker" }, 200, requestId);
    }

    // Only /mcp is proxied
    if (pathname !== "/mcp") {
      return jsonResponse({ ok: false, error: "Not found" }, 404, requestId);
    }

    if (!["GET", "POST", "DELETE", "HEAD"].includes(method)) {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405, requestId);
    }

    // Body size guard
    const maxBytes = optionalInt(env.MCP_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
    const contentLength = request.headers.get("content-length");
    if (contentLength) {
      const parsed = Number.parseInt(contentLength, 10);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        return jsonResponse({ ok: false, error: "Request body too large", limit_bytes: maxBytes }, 413, requestId);
      }
    }

    // Forward to container — no auth check, api.runcomfy.net handles it
    const start = Date.now();
    try {
      const instanceName = env.CONTAINER_INSTANCE_NAME?.trim() || DEFAULT_CONTAINER_INSTANCE_NAME;
      const container = getContainer(env.RUNCOMFY_MCP_CONTAINER, instanceName);
      const response = await container.fetch(buildForwardedRequest(request, requestId));
      const final = finalizeResponse(response, requestId);
      log("info", "worker.proxy.complete", {
        requestId,
        method,
        status: final.status,
        durationMs: Date.now() - start,
      });
      return final;
    } catch (error) {
      log("error", "worker.proxy.error", {
        requestId,
        method,
        durationMs: Date.now() - start,
        error: toErrorDetails(error),
      });
      return jsonResponse(
        { ok: false, error: "Failed to reach MCP container", detail: toErrorDetails(error).message },
        502,
        requestId,
      );
    }
  },
};

export default worker;
