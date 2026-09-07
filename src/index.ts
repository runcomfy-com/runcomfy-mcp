import { Container, getContainer } from "@cloudflare/containers";
import {
  OAuthProvider,
  OAuthError,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  handleOAuthBridgeRequest,
  validateRunComfyAccessToken,
  type RunComfyOAuthProps,
} from "./oauth-bridge";

const CONTAINER_PORT = 8000;
const DEFAULT_CONTAINER_INSTANCE_NAME = "runcomfy-unified";
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_PORT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_INTERVAL_MS = 300;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const OAUTH_ENDPOINT_MAX_BODY_BYTES = 16 * 1024;
const CANONICAL_MCP_RESOURCE = "https://mcp.runcomfy.com/mcp";
const MCP_SCOPE = "mcp:tools";
const MCP_PATH = "/mcp";
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const MAX_REGISTERED_REDIRECT_URIS = 5;
const PROFILE_URL = "https://www.runcomfy.com/profile";

/**
 * Hosted MCP clients that cannot use a loopback callback. Each entry must be a
 * full, exact redirect URI owned by the client vendor; anything else has to go
 * through a loopback callback so a stolen authorization code can only be
 * delivered to the user's own machine.
 *
 * ChatGPT has a second, per-connector callback form
 * (`https://chatgpt.com/connector/oauth/{callback_id}`) that would need a
 * prefix match rather than an exact one. It is deliberately not listed: that
 * form is only used for authorization servers without RFC 9207 issuer
 * identification, and this server publishes
 * `authorization_response_iss_parameter_supported` and returns a matching
 * `iss` on every authorization response, so ChatGPT uses the stable URI below.
 */
const HOSTED_CLIENT_REDIRECT_URIS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://connect.smithery.ai/oauth/callback",
]);

const LOOPBACK_REDIRECT_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface Env {
  RUNCOMFY_MCP_CONTAINER: DurableObjectNamespace<RuncomfyMcpContainer>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_DCR_RATE_LIMITER: RateLimit;
  MCP_AUTHORIZE_RATE_LIMITER: RateLimit;
  MCP_DIRECT_TOKEN_RATE_LIMITER: RateLimit;
  CONTAINER_INSTANCE_NAME?: string;
  CONTAINER_STARTUP_TIMEOUT_MS?: string;
  CONTAINER_PORT_READY_TIMEOUT_MS?: string;
  CONTAINER_WAIT_INTERVAL_MS?: string;
  MCP_MAX_BODY_BYTES?: string;
  OPENAI_APPS_CHALLENGE?: string;
  RUNCOMFY_SERVERLESS_BASE_URL?: string;
  RUNCOMFY_MODEL_API_BASE_URL?: string;
  RUNCOMFY_TRAINER_API_BASE_URL?: string;
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
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildCorsHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, HEAD, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, accept, x-request-id, mcp-session-id, last-event-id",
    "access-control-expose-headers": "x-request-id, www-authenticate, retry-after",
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
  for (const [key, value] of response.headers.entries()) headers.set(key, value);
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
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.replace(/\/+$/, "") : pathname;
}

type RequestBodyGuardResult =
  | { ok: true; request: Request }
  | { ok: false; response: Response };

export async function guardRequestBody(
  request: Request,
  maxBytes: number,
  errorResponse: (status: 400 | 413) => Response,
): Promise<RequestBodyGuardResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const normalizedLength = declaredLength.trim();
    const parsedLength = /^\d+$/.test(normalizedLength)
      ? Number.parseInt(normalizedLength, 10)
      : Number.NaN;
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) {
      await cancelBody(request.body);
      return { ok: false, response: errorResponse(413) };
    }
  }

  if (!request.body) return { ok: true, request };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, response: errorResponse(413) };
      }
      chunks.push(value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The stream is already failed or closed.
    }
    return { ok: false, response: errorResponse(400) };
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return {
    ok: true,
    request: new Request(request, {
      headers,
      body,
    }),
  };
}

async function guardOAuthEndpointBody(request: Request): Promise<RequestBodyGuardResult> {
  return guardRequestBody(request, OAUTH_ENDPOINT_MAX_BODY_BYTES, (status) =>
    oauthBodyError(status, status === 413 ? "Request body too large" : "Invalid request body"),
  );
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Rejecting the request is sufficient if the incoming stream cannot be cancelled.
  }
}

function oauthBodyError(status: 400 | 413, description: string): Response {
  return new Response(
    JSON.stringify({ error: "invalid_request", error_description: description }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function isRunComfyOAuthProps(value: unknown): value is RunComfyOAuthProps {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<RunComfyOAuthProps>;
  return (
    candidate.authKind === "runcomfy_oauth" &&
    typeof candidate.runcomfyToken === "string" &&
    candidate.runcomfyToken.length >= 32 &&
    candidate.runcomfyToken.length <= 4_096 &&
    /^[\x21-\x7e]+$/.test(candidate.runcomfyToken) &&
    typeof candidate.userId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.userId) &&
    Array.isArray(candidate.scopes) &&
    candidate.scopes.length === 1 &&
    candidate.scopes[0] === MCP_SCOPE
  );
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[ \t]+([\x21-\x7e]+)[ \t]*$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * OAuthProvider only ever mints `${userId}:${grantId}:${secret}` tokens and
 * rejects any other shape before it reaches KV. A RunComfy Profile API token
 * never contains a colon, so the two credential kinds are unambiguous and a
 * RunComfy token can be honoured directly without loosening OAuth handling.
 */
export function isProviderIssuedToken(token: string): boolean {
  return token.split(":").length === 3;
}

/**
 * Redirect URIs accepted from dynamic client registration. Loopback callbacks
 * are open by port because RFC 8252 native clients bind an ephemeral one, and
 * an authorization code delivered there never leaves the user's own machine.
 * Every other destination must be an exact, vendor-owned entry so a public
 * registration cannot be used to redirect someone else's code off-host.
 */
export function isAllowedRedirectUri(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  if (HOSTED_CLIENT_REDIRECT_URIS.has(value)) return true;

  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    return false;
  }
  if (uri.hash) return false;
  return uri.protocol === "http:" && LOOPBACK_REDIRECT_HOSTS.has(uri.hostname);
}

function unauthorizedMcpResponse(
  request: Request,
  description: string,
  requestId: string,
): Response {
  const response = jsonResponse(
    { error: "invalid_token", error_description: description },
    401,
    requestId,
  );
  response.headers.set(
    "www-authenticate",
    `Bearer realm="OAuth", resource_metadata="${new URL(request.url).origin}${RESOURCE_METADATA_PATH}", error="invalid_token", scope="${MCP_SCOPE}"`,
  );
  return response;
}

async function guardMcpBody(
  request: Request,
  env: Env,
  requestId: string,
): Promise<RequestBodyGuardResult> {
  const maxBytes = optionalInt(env.MCP_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  return guardRequestBody(request, maxBytes, (status) =>
    jsonResponse(
      {
        ok: false,
        error: status === 413 ? "Request body too large" : "Invalid request body",
        ...(status === 413 ? { limit_bytes: maxBytes } : {}),
      },
      status,
      requestId,
    ),
  );
}

async function proxyToContainer(
  env: Env,
  request: Request,
  requestId: string,
  runcomfyToken: string,
  authKind: string,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const start = Date.now();
  try {
    const instanceName = env.CONTAINER_INSTANCE_NAME?.trim() || DEFAULT_CONTAINER_INSTANCE_NAME;
    const container = getContainer(env.RUNCOMFY_MCP_CONTAINER, instanceName);
    const response = await container.fetch(
      buildForwardedRequest(request, requestId, runcomfyToken),
    );
    const final = finalizeResponse(response, requestId);
    log("info", "worker.proxy.complete", {
      requestId,
      method,
      status: final.status,
      durationMs: Date.now() - start,
      authKind,
    });
    return final;
  } catch (error) {
    log("error", "worker.proxy.error", {
      requestId,
      method,
      durationMs: Date.now() - start,
      error: toErrorDetails(error),
    });
    return jsonResponse({ ok: false, error: "Failed to reach MCP container" }, 502, requestId);
  }
}

/**
 * Serves `/mcp` for clients that present a RunComfy Profile API token directly,
 * which is the documented setup for Claude Code, Cursor, Windsurf, VS Code and
 * any other Streamable HTTP client that cannot run the browser OAuth flow. The
 * token is verified against the RunComfy API on every request, so revoking it
 * in Profile takes effect immediately, and it is swapped for the internal
 * identity header before the container ever sees the request.
 */
async function handleDirectTokenMcpRequest(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const requestId = getRequestId(request);
  const method = request.method.toUpperCase();
  if (!["GET", "POST", "DELETE", "HEAD"].includes(method)) {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, requestId);
  }

  // Unlike the OAuth path this accepts an arbitrary caller-supplied string, so
  // cap how fast one source can probe it. The ceiling is far above any real
  // MCP client's tool-call rate.
  const actor = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const { success } = await env.MCP_DIRECT_TOKEN_RATE_LIMITER.limit({ key: `direct:${actor}` });
  if (!success) {
    const limited = jsonResponse(
      { ok: false, error: "Too many requests" },
      429,
      requestId,
    );
    limited.headers.set("retry-after", "60");
    return limited;
  }

  const validation = await validateRunComfyAccessToken(token, null);
  if (!validation.ok) {
    if (validation.kind === "invalid") {
      return unauthorizedMcpResponse(
        request,
        `RunComfy rejected this API token. Copy a current token from ${PROFILE_URL} and send it as "Authorization: Bearer <token>".`,
        requestId,
      );
    }
    const unavailable = jsonResponse(
      { ok: false, error: "RunComfy authorization is temporarily unavailable" },
      503,
      requestId,
    );
    unavailable.headers.set("retry-after", "5");
    return unavailable;
  }

  let containerRequest = request;
  if (method === "POST" || method === "DELETE") {
    const guarded = await guardMcpBody(request, env, requestId);
    if (!guarded.ok) return guarded.response;
    containerRequest = guarded.request;
  }

  return proxyToContainer(env, containerRequest, requestId, token, "runcomfy_api_token");
}

/**
 * Build the only request shape accepted by the internal Python service.
 * Authentication is passed explicitly from validated, encrypted OAuth props;
 * every public/internal identity header supplied by the caller is discarded.
 */
export function buildForwardedRequest(
  request: Request,
  requestId: string,
  runcomfyToken: string,
): Request {
  const headers = new Headers(request.headers);
  const url = new URL(request.url);

  headers.delete("authorization");
  headers.delete("x-mcp-secret");
  headers.delete("x-runcomfy-user-token");
  headers.delete("x-runcomfy-user-token-fingerprint");
  headers.set("x-runcomfy-user-token", runcomfyToken);
  headers.set("x-request-id", requestId);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set("x-forwarded-host", url.host);
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
            RUNCOMFY_MCP_MOUNT_PREFIX: "",
            ...(this.env.RUNCOMFY_SERVERLESS_BASE_URL
              ? { RUNCOMFY_SERVERLESS_BASE_URL: this.env.RUNCOMFY_SERVERLESS_BASE_URL }
              : {}),
            ...(this.env.RUNCOMFY_MODEL_API_BASE_URL
              ? { RUNCOMFY_MODEL_API_BASE_URL: this.env.RUNCOMFY_MODEL_API_BASE_URL }
              : {}),
            ...(this.env.RUNCOMFY_TRAINER_API_BASE_URL
              ? { RUNCOMFY_TRAINER_API_BASE_URL: this.env.RUNCOMFY_TRAINER_API_BASE_URL }
              : {}),
          },
          entrypoint: ["python", "-m", "container_entrypoint"],
          enableInternet: true,
        },
        cancellationOptions: {
          instanceGetTimeoutMS: optionalInt(
            this.env.CONTAINER_STARTUP_TIMEOUT_MS,
            DEFAULT_STARTUP_TIMEOUT_MS,
          ),
          portReadyTimeoutMS: optionalInt(
            this.env.CONTAINER_PORT_READY_TIMEOUT_MS,
            DEFAULT_PORT_READY_TIMEOUT_MS,
          ),
          waitInterval: optionalInt(this.env.CONTAINER_WAIT_INTERVAL_MS, DEFAULT_WAIT_INTERVAL_MS),
        },
      });

      const internalUrl = new URL(request.url);
      internalUrl.protocol = "http:";
      internalUrl.hostname = "localhost";
      internalUrl.port = String(CONTAINER_PORT);
      const response = await this.containerFetch(
        new Request(internalUrl.toString(), request),
        CONTAINER_PORT,
      );
      return finalizeResponse(response, requestId);
    } catch (error) {
      log("error", "container.proxy.error", {
        requestId,
        durationMs: Date.now() - start,
        error: toErrorDetails(error),
      });
      return jsonResponse({ ok: false, error: "Failed to reach MCP container" }, 502, requestId);
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

export class McpApiHandler extends WorkerEntrypoint<Env, RunComfyOAuthProps> {
  override async fetch(request: Request): Promise<Response> {
    const requestId = getRequestId(request);
    const url = new URL(request.url);
    const pathname = normalizePathname(url.pathname);
    const method = request.method.toUpperCase();

    if (pathname !== MCP_PATH) {
      return jsonResponse({ ok: false, error: "Not found" }, 404, requestId);
    }
    if (!["GET", "POST", "DELETE", "HEAD"].includes(method)) {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405, requestId);
    }
    if (!isRunComfyOAuthProps(this.ctx.props)) {
      return jsonResponse({ ok: false, error: "Invalid authentication context" }, 401, requestId);
    }

    // OAuth tokens are short-lived, while the underlying RunComfy credential
    // may be revoked independently. Revalidate its owner for every MCP request.
    const validation = await validateRunComfyAccessToken(
      this.ctx.props.runcomfyToken,
      this.ctx.props.userId,
    );
    if (!validation.ok) {
      if (validation.kind === "invalid") {
        return jsonResponse({ ok: false, error: "RunComfy authorization was revoked" }, 401, requestId);
      }
      const unavailable = jsonResponse(
        { ok: false, error: "RunComfy authorization is temporarily unavailable" },
        503,
        requestId,
      );
      unavailable.headers.set("retry-after", "5");
      return unavailable;
    }

    let containerRequest = request;
    if (method === "POST" || method === "DELETE") {
      const guarded = await guardMcpBody(request, this.env, requestId);
      if (!guarded.ok) return guarded.response;
      containerRequest = guarded.request;
    }

    return proxyToContainer(
      this.env,
      containerRequest,
      requestId,
      this.ctx.props.runcomfyToken,
      this.ctx.props.authKind,
    );
  }
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const bridged = await handleOAuthBridgeRequest(request, env);
    if (bridged) return bridged;

    const requestId = getRequestId(request);
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && ["GET", "HEAD"].includes(request.method.toUpperCase())) {
      return jsonResponse({ ok: true, service: "runcomfy-mcp-worker" }, 200, requestId);
    }
    return jsonResponse({ ok: false, error: "Not found" }, 404, requestId);
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  allowPlainPKCE: false,
  allowImplicitFlow: false,
  allowTokenExchangeGrant: false,
  accessTokenTTL: 15 * 60,
  refreshTokenTTL: 30 * 24 * 60 * 60,
  clientRegistrationTTL: 30 * 24 * 60 * 60,
  scopesSupported: [MCP_SCOPE],
  resourceMetadata: {
    resource: CANONICAL_MCP_RESOURCE,
    authorization_servers: ["https://mcp.runcomfy.com"],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "RunComfy MCP",
  },
  tokenExchangeCallback: async ({ props, requestedScope }) => {
    if (!requestedScope.includes(MCP_SCOPE) || !isRunComfyOAuthProps(props)) {
      throw new OAuthError("invalid_grant", {
        description: "The RunComfy MCP authorization is no longer valid",
      });
    }
    const validation = await validateRunComfyAccessToken(props.runcomfyToken, props.userId);
    if (!validation.ok) {
      if (validation.kind === "invalid") {
        throw new OAuthError("invalid_grant", {
          description: "The RunComfy authorization was revoked",
        });
      }
      throw new OAuthError("temporarily_unavailable", {
        description: "RunComfy authorization validation is temporarily unavailable",
        statusCode: 503,
        headers: { "Retry-After": "5" },
      });
    }
    return { accessTokenScope: [MCP_SCOPE] };
  },
  clientRegistrationCallback: ({ clientMetadata }) => {
    const redirectUris = clientMetadata.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > MAX_REGISTERED_REDIRECT_URIS ||
      !redirectUris.every(isAllowedRedirectUri)
    ) {
      return {
        code: "invalid_client_metadata",
        description:
          "redirect_uris must be loopback callbacks (http://localhost, http://127.0.0.1 or http://[::1] on any port), as used by Claude Code and other local MCP clients, or a supported hosted client callback.",
        status: 400,
      };
    }
    return undefined;
  },
});

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === OPENAI_APPS_CHALLENGE_PATH && request.method === "GET") {
      const challenge = env.OPENAI_APPS_CHALLENGE;
      return new Response(challenge || "Not found", {
        status: challenge ? 200 : 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    let providerRequest: Request = request;
    if (
      request.method === "POST" &&
      (url.pathname === "/oauth/token" || url.pathname === "/oauth/register")
    ) {
      const guarded = await guardOAuthEndpointBody(request);
      if (!guarded.ok) return guarded.response;
      providerRequest = guarded.request;
    }

    // A RunComfy Profile API token presented straight to /mcp is the setup the
    // RunComfy docs give for Claude Code, Cursor, Windsurf and VS Code.
    // OAuthProvider would reject it as an unknown access token, so it is
    // handled here before the provider sees the request. Provider-issued
    // tokens are left untouched and still take the OAuth path below.
    if (normalizePathname(url.pathname) === MCP_PATH) {
      const bearer = readBearerToken(request);
      if (bearer && !isProviderIssuedToken(bearer)) {
        return handleDirectTokenMcpRequest(providerRequest, env, bearer);
      }
    }

    const actor = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
    if (url.pathname === "/oauth/register" && request.method === "POST") {
      const { success } = await env.MCP_DCR_RATE_LIMITER.limit({ key: `dcr:${actor}` });
      if (!success) {
        return new Response(
          JSON.stringify({
            error: "temporarily_unavailable",
            error_description: "Registration rate limit exceeded",
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              "retry-after": "60",
            },
          },
        );
      }
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      const { success } = await env.MCP_AUTHORIZE_RATE_LIMITER.limit({ key: `authorize:${actor}` });
      if (!success) {
        return new Response("Authorization rate limit exceeded", {
          status: 429,
          headers: { "cache-control": "no-store", "retry-after": "60" },
        });
      }
    }
    return provider.fetch(providerRequest, env, ctx);
  },
  async scheduled(_event, env): Promise<void> {
    await provider.purgeExpiredData(env, { batchSize: 100 });
  },
};

export default worker;
