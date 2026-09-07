import {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

const DEFAULT_RUNCOMFY_WEB_BASE_URL = "https://www.runcomfy.com";
const RUNCOMFY_TOKEN_VALIDATION_URL = "https://api.runcomfy.net/prod/v2/deployments";
const CANONICAL_MCP_ORIGIN = "https://mcp.runcomfy.com";
const AUTHORIZE_PATH = "/authorize";
const COMPLETE_PATH = "/oauth/authorize/complete";
const PROFILE_PATH = "/profile";
const MCP_SCOPE = "mcp:tools";
const BRIDGE_KEY_PREFIX = "runcomfy:oauth-consent:v1:";
const BRIDGE_VERSION = 1;
const BRIDGE_TTL_SECONDS = 10 * 60;
const MAX_FORM_BODY_BYTES = 8 * 1024;
const MAX_STORED_REQUEST_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 7_000;

export interface RunComfyOAuthProps {
  runcomfyToken: string;
  userId: string;
  authKind: "runcomfy_oauth";
  scopes: ["mcp:tools"];
}

export interface OAuthBridgeEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  RUNCOMFY_WEB_BASE_URL?: string;
}

export type RunComfyAccessTokenValidation =
  | { ok: true; userId: string }
  | { ok: false; kind: "invalid" | "unavailable" };

interface ConsentSession {
  version: typeof BRIDGE_VERSION;
  request: AuthRequest;
  clientName: string;
  redirectOrigin: string;
  csrfHash: string;
  expiresAt: number;
}

type ConsentAction =
  | {
      kind: "authorize";
      sessionId: string;
      csrfToken: string;
      token: string;
    }
  | {
      kind: "cancel";
      sessionId: string;
      csrfToken: string;
    };

/**
 * Handles the application-owned OAuth consent routes. OAuthProvider owns the
 * metadata, token, registration, revocation, and protected API routes.
 */
export async function handleOAuthBridgeRequest(
  request: Request,
  env: OAuthBridgeEnv,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === AUTHORIZE_PATH) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return handleAuthorize(request, env);
  }

  if (url.pathname === COMPLETE_PATH) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return handleComplete(request, env);
  }

  return null;
}

/**
 * Validates a RunComfy API token without exposing it to the caller or logs.
 * expectedUserId may be null during first-time consent; protected MCP requests
 * must pass the pseudonymous token subject embedded in encrypted OAuth props.
 * The primary RunComfy API is authoritative, so revocation behavior matches
 * the downstream tool calls and does not depend on the separate website app.
 */
export async function validateRunComfyAccessToken(
  token: string,
  expectedUserId: string | null,
): Promise<RunComfyAccessTokenValidation> {
  if (
    !isSafeBearerToken(token) ||
    (expectedUserId !== null && !isUuidLike(expectedUserId))
  ) {
    return { ok: false, kind: "invalid" };
  }

  try {
    const userId = await tokenSubjectUserId(token);
    if (expectedUserId !== null && userId !== expectedUserId) {
      return { ok: false, kind: "invalid" };
    }

    const status = await fetchRunComfyTokenStatus(token);
    if (status === 401 || status === 403) {
      return { ok: false, kind: "invalid" };
    }
    if (status !== 200) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "runcomfy.token_validation.unavailable",
          status,
        }),
      );
      return { ok: false, kind: "unavailable" };
    }

    return { ok: true, userId };
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "runcomfy.token_validation.error",
        errorType: error instanceof Error ? error.name : "Error",
      }),
    );
    return { ok: false, kind: "unavailable" };
  }
}

async function handleAuthorize(request: Request, env: OAuthBridgeEnv): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return authorizationErrorResponse(error);
    }
    return localErrorResponse("Unable to validate this authorization request.", 400);
  }

  // Require OAuth 2.1 PKCE even for confidential clients. The provider
  // already verifies the challenge at token exchange; this closes its
  // intentional compatibility allowance for confidential clients that omit
  // PKCE entirely.
  if (!hasValidS256Pkce(oauthRequest)) {
    return parsedAuthorizationError(
      oauthRequest,
      "invalid_request",
      "A valid S256 PKCE code challenge is required.",
    );
  }

  if (!isStorableAuthRequest(oauthRequest)) {
    return parsedAuthorizationError(
      oauthRequest,
      "invalid_request",
      "The authorization request is too large or malformed.",
    );
  }

  const requestedScopes = [...new Set(oauthRequest.scope)];
  if (
    requestedScopes.some((scope) => scope !== MCP_SCOPE) ||
    (requestedScopes.length > 0 && !requestedScopes.includes(MCP_SCOPE))
  ) {
    return parsedAuthorizationError(
      oauthRequest,
      "invalid_scope",
      `Only the ${MCP_SCOPE} scope is supported.`,
    );
  }

  let clientName: string;
  try {
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) {
      return parsedAuthorizationError(
        oauthRequest,
        "unauthorized_client",
        "The OAuth client is not registered.",
      );
    }
    clientName = normalizeClientName(client.clientName);
  } catch {
    return parsedAuthorizationError(
      oauthRequest,
      "temporarily_unavailable",
      "The OAuth client could not be verified. Try again shortly.",
    );
  }

  const redirectOrigin = getRedirectOriginLabel(oauthRequest.redirectUri);
  if (!redirectOrigin) {
    return parsedAuthorizationError(
      oauthRequest,
      "invalid_request",
      "The registered callback could not be displayed safely.",
    );
  }

  let profileUrl: string;
  try {
    profileUrl = new URL(PROFILE_PATH, getRunComfyWebBase(env)).toString();
  } catch {
    return parsedAuthorizationError(
      oauthRequest,
      "server_error",
      "RunComfy authorization is not configured.",
    );
  }

  const sessionId = randomOpaqueToken(32);
  const csrfToken = randomOpaqueToken(32);
  const session: ConsentSession = {
    version: BRIDGE_VERSION,
    request: oauthRequest,
    clientName,
    redirectOrigin,
    csrfHash: await sha256Base64Url(csrfToken),
    expiresAt: Date.now() + BRIDGE_TTL_SECONDS * 1_000,
  };

  try {
    await env.OAUTH_KV.put(bridgeKey(sessionId), JSON.stringify(session), {
      expirationTtl: BRIDGE_TTL_SECONDS,
    });
  } catch {
    return parsedAuthorizationError(
      oauthRequest,
      "temporarily_unavailable",
      "The authorization request could not be saved. Try again shortly.",
    );
  }

  return consentPage({
    clientName,
    formActionSource: formActionSource(oauthRequest.redirectUri),
    csrfToken,
    profileUrl,
    redirectOrigin,
    sessionId,
  });
}

function hasValidS256Pkce(request: AuthRequest): boolean {
  return (
    request.codeChallengeMethod === "S256" &&
    typeof request.codeChallenge === "string" &&
    /^[A-Za-z0-9._~-]{43,128}$/.test(request.codeChallenge)
  );
}

async function handleComplete(request: Request, env: OAuthBridgeEnv): Promise<Response> {
  if (!isSameOriginFormPost(request)) {
    return localErrorResponse("Forbidden.", 403);
  }

  let action: ConsentAction;
  try {
    action = await readConsentAction(request);
  } catch (error) {
    if (error instanceof FormReadError) {
      return localErrorResponse(error.publicMessage, error.status);
    }
    return localErrorResponse("Invalid authorization form.", 400);
  }

  const key = bridgeKey(action.sessionId);
  let stored: string | null;
  try {
    stored = await env.OAUTH_KV.get(key, "text");
  } catch {
    return retryPage("RunComfy could not reach its authorization storage just now.", 503);
  }

  // A consent session is single-use: it is deleted once the authorization
  // completes. The overwhelmingly common way to arrive here is resubmitting an
  // already-completed page, which no amount of retrying can fix, so the page
  // must send the user back to the client to start over. Cloudflare KV is also
  // eventually consistent, so a genuinely fresh session can briefly read as
  // missing; starting over is the correct recovery for that case too.
  if (stored === null) {
    return retryPage(
      "This authorization link is no longer valid. It has either already been used, or it expired.",
      400,
    );
  }

  const session = parseConsentSession(stored);
  if (!session) {
    await deleteConsentSession(env, key);
    return localErrorResponse("The authorization session is invalid.", 400);
  }

  if (session.expiresAt <= Date.now()) {
    await deleteConsentSession(env, key);
    return storedAuthorizationError(
      session.request,
      "access_denied",
      "The authorization request expired before it was approved.",
    );
  }

  const presentedCsrfHash = await sha256Base64Url(action.csrfToken);
  if (!constantTimeEqual(session.csrfHash, presentedCsrfHash)) {
    return localErrorResponse("Forbidden.", 403);
  }

  if (action.kind === "cancel") {
    await deleteConsentSession(env, key);
    return storedAuthorizationError(
      session.request,
      "access_denied",
      "The user declined the authorization request.",
    );
  }

  let profileUrl: string;
  try {
    profileUrl = new URL(PROFILE_PATH, getRunComfyWebBase(env)).toString();
  } catch {
    return localErrorResponse("RunComfy authorization is not configured.", 500);
  }

  const validation = await validateRunComfyAccessToken(action.token, null);
  if (!validation.ok) {
    return consentPage(
      {
        clientName: session.clientName,
        csrfToken: action.csrfToken,
        profileUrl,
        redirectOrigin: session.redirectOrigin,
        formActionSource: formActionSource(session.request.redirectUri),
        sessionId: action.sessionId,
        error:
          validation.kind === "invalid"
            ? "That RunComfy API token could not be verified. Check it in your RunComfy Profile and try again."
            : "RunComfy could not verify the token right now. Please try again.",
      },
      validation.kind === "invalid" ? 401 : 503,
    );
  }

  let redirectTo: string;
  try {
    const completed = await env.OAUTH_PROVIDER.completeAuthorization({
      request: session.request,
      userId: validation.userId,
      metadata: {
        clientName: session.clientName,
        redirectOrigin: session.redirectOrigin,
      },
      scope: [MCP_SCOPE],
      props: {
        runcomfyToken: action.token,
        userId: validation.userId,
        authKind: "runcomfy_oauth",
        scopes: [MCP_SCOPE],
      } satisfies RunComfyOAuthProps,
    });
    redirectTo = completed.redirectTo;
    if (typeof redirectTo !== "string" || redirectTo.length === 0 || redirectTo.length > 16_384) {
      throw new Error("OAuth provider returned an invalid redirect");
    }
  } catch {
    // The user supplied an existing revocable token, so retrying cannot orphan
    // a newly minted upstream credential. Keep the consent session alive.
    return consentPage(
      {
        clientName: session.clientName,
        csrfToken: action.csrfToken,
        profileUrl,
        redirectOrigin: session.redirectOrigin,
        formActionSource: formActionSource(session.request.redirectUri),
        sessionId: action.sessionId,
        error: "Authorization could not be completed. Please enter your RunComfy API token and try again.",
      },
      503,
    );
  }

  await deleteConsentSession(env, key);
  return redirectResponse(redirectTo);
}

async function readConsentAction(request: Request): Promise<ConsentAction> {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    throw new FormReadError(415, "The authorization form has an unsupported content type.");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const normalizedLength = declaredLength.trim();
    const parsedLength = /^\d+$/.test(normalizedLength)
      ? Number.parseInt(normalizedLength, 10)
      : Number.NaN;
    if (!Number.isSafeInteger(parsedLength) || parsedLength > MAX_FORM_BODY_BYTES) {
      throw new FormReadError(413, "The authorization form is too large.");
    }
  }

  const body = await readBoundedBody(request.body, MAX_FORM_BODY_BYTES);
  const form = new URLSearchParams(new TextDecoder().decode(body));
  if ([...form.keys()].some((key) => !["action", "session", "csrf", "token"].includes(key))) {
    throw new FormReadError(400, "The authorization form is invalid.");
  }

  const action = singleFormValue(form, "action");
  const sessionId = singleFormValue(form, "session");
  const csrfToken = singleFormValue(form, "csrf");
  if (
    (action !== "authorize" && action !== "cancel") ||
    !isOpaqueToken(sessionId) ||
    !isOpaqueToken(csrfToken)
  ) {
    throw new FormReadError(400, "The authorization form is invalid.");
  }

  if (action === "cancel") {
    const tokenValues = form.getAll("token");
    if (tokenValues.length > 1) {
      throw new FormReadError(400, "The authorization form is invalid.");
    }
    return { kind: "cancel", sessionId, csrfToken };
  }

  const token = singleFormValue(form, "token");
  return { kind: "authorize", sessionId, csrfToken, token };
}

function singleFormValue(form: URLSearchParams, key: string): string {
  const values = form.getAll(key);
  if (values.length !== 1) {
    throw new FormReadError(400, "The authorization form is invalid.");
  }
  return values[0] ?? "";
}

function isSameOriginFormPost(request: Request): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return false;
  try {
    return (
      new URL(originHeader).origin === CANONICAL_MCP_ORIGIN &&
      new URL(request.url).origin === CANONICAL_MCP_ORIGIN
    );
  } catch {
    return false;
  }
}

function getRunComfyWebBase(env: Pick<OAuthBridgeEnv, "RUNCOMFY_WEB_BASE_URL">): URL {
  const configured = env.RUNCOMFY_WEB_BASE_URL?.trim() || DEFAULT_RUNCOMFY_WEB_BASE_URL;
  const url = new URL(configured);
  const allowedOrigin = new URL(DEFAULT_RUNCOMFY_WEB_BASE_URL).origin;
  if (
    url.protocol !== "https:" ||
    url.origin !== allowedOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("RUNCOMFY_WEB_BASE_URL must be the canonical RunComfy HTTPS origin");
  }
  return new URL(url.origin);
}

async function fetchRunComfyTokenStatus(token: string): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(RUNCOMFY_TOKEN_VALIDATION_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      // Cloudflare Workers supports follow/manual, not Request's "error"
      // mode. Manual preserves the fixed-origin boundary because redirects
      // are returned to us and classified as unavailable rather than followed.
      redirect: "manual",
      signal: controller.signal,
    });
    try {
      await response.body?.cancel();
    } catch {
      // Status remains authoritative even if the runtime cannot cancel the
      // primary API response stream.
    }
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

async function tokenSubjectUserId(token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ).slice(0, 16);
  // RFC 9562 version 8 marks an application-defined UUID. This produces a
  // stable, non-reversible OAuth subject without exposing the RunComfy token.
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  declaredLength: string | null = null,
): Promise<Uint8Array> {
  if (declaredLength) {
    const normalizedLength = declaredLength.trim();
    const parsedLength = /^\d+$/.test(normalizedLength)
      ? Number.parseInt(normalizedLength, 10)
      : Number.NaN;
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) {
      await stream?.cancel();
      throw new FormReadError(413, "The request body is too large.");
    }
  }

  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FormReadError(413, "The request body is too large.");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseConsentSession(stored: string): ConsentSession | null {
  if (stored.length === 0 || stored.length > MAX_STORED_REQUEST_BYTES * 2) return null;

  let value: unknown;
  try {
    value = JSON.parse(stored) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(value)) return null;
  const candidate = value as Partial<ConsentSession>;
  if (
    candidate.version !== BRIDGE_VERSION ||
    !isStorableAuthRequest(candidate.request) ||
    typeof candidate.clientName !== "string" ||
    candidate.clientName.length === 0 ||
    candidate.clientName.length > 120 ||
    typeof candidate.redirectOrigin !== "string" ||
    candidate.redirectOrigin.length === 0 ||
    candidate.redirectOrigin.length > 2_048 ||
    typeof candidate.csrfHash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(candidate.csrfHash) ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isFinite(candidate.expiresAt)
  ) {
    return null;
  }

  return candidate as ConsentSession;
}

function isStorableAuthRequest(value: unknown): value is AuthRequest {
  if (!isRecord(value)) return false;
  if (
    value.responseType !== "code" ||
    typeof value.clientId !== "string" ||
    value.clientId.length === 0 ||
    value.clientId.length > 4_096 ||
    typeof value.redirectUri !== "string" ||
    value.redirectUri.length === 0 ||
    value.redirectUri.length > 8_192 ||
    !Array.isArray(value.scope) ||
    value.scope.length > 32 ||
    !value.scope.every((scope) => typeof scope === "string" && scope.length <= 256) ||
    typeof value.state !== "string" ||
    value.state.length > 4_096
  ) {
    return false;
  }

  if (
    (value.codeChallenge !== undefined &&
      (typeof value.codeChallenge !== "string" || value.codeChallenge.length > 256)) ||
    (value.codeChallengeMethod !== undefined &&
      (typeof value.codeChallengeMethod !== "string" || value.codeChallengeMethod.length > 16)) ||
    (value.issuer !== undefined &&
      (typeof value.issuer !== "string" || value.issuer.length > 2_048)) ||
    !isValidResource(value.resource)
  ) {
    return false;
  }

  try {
    return JSON.stringify(value).length <= MAX_STORED_REQUEST_BYTES;
  } catch {
    return false;
  }
}

function isValidResource(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === "string") return value.length <= 4_096;
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every((resource) => typeof resource === "string" && resource.length <= 4_096)
  );
}

function authorizationErrorResponse(error: AuthorizationError): Response {
  if (!error.redirectUri) {
    return localErrorResponse(error.description, 400);
  }

  try {
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return redirectResponse(redirect.toString());
  } catch {
    return localErrorResponse("The authorization request is invalid.", 400);
  }
}

function parsedAuthorizationError(
  request: AuthRequest,
  code:
    | "invalid_request"
    | "unauthorized_client"
    | "invalid_scope"
    | "server_error"
    | "temporarily_unavailable",
  description: string,
): Response {
  return storedAuthorizationError(request, code, description);
}

function storedAuthorizationError(
  request: AuthRequest,
  code:
    | "invalid_request"
    | "unauthorized_client"
    | "invalid_scope"
    | "access_denied"
    | "server_error"
    | "temporarily_unavailable",
  description: string,
): Response {
  try {
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("error", code);
    redirect.searchParams.set("error_description", description);
    if (request.state) redirect.searchParams.set("state", request.state);
    if (request.issuer) redirect.searchParams.set("iss", request.issuer);
    return redirectResponse(redirect.toString());
  } catch {
    return localErrorResponse("Authorization failed.", 400);
  }
}

function consentPage(
  options: {
    clientName: string;
    csrfToken: string;
    profileUrl: string;
    redirectOrigin: string;
    formActionSource?: string | null;
    sessionId: string;
    error?: string;
  },
  status = 200,
): Response {
  const nonce = randomOpaqueToken(18);
  const clientName = escapeHtml(options.clientName);
  const csrfToken = escapeHtml(options.csrfToken);
  const profileUrl = escapeHtml(options.profileUrl);
  const redirectOrigin = escapeHtml(options.redirectOrigin);
  const sessionId = escapeHtml(options.sessionId);
  const error = options.error
    ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize RunComfy MCP</title>
  <style nonce="${nonce}">
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #171717; background: #f6f7f9; }
    main { width: min(100%, 540px); padding: 32px; border: 1px solid #dedfe3; border-radius: 16px; background: #fff; box-shadow: 0 12px 40px rgb(0 0 0 / 8%); }
    h1 { margin: 0 0 14px; font-size: 1.6rem; line-height: 1.2; }
    p { margin: 12px 0; line-height: 1.55; }
    .identity { padding: 14px; border: 1px solid #dedfe3; border-radius: 10px; background: #f8f9fb; }
    .identity strong, .identity code { display: block; overflow-wrap: anywhere; }
    .identity code { margin-top: 5px; font-size: .86rem; }
    label { display: block; margin: 20px 0 7px; font-weight: 650; }
    input[type="password"] { width: 100%; min-height: 46px; padding: 10px 12px; border: 1px solid #aeb2bb; border-radius: 8px; font: inherit; }
    input[type="password"]:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid #6d78ff; outline-offset: 2px; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    button { min-height: 44px; padding: 10px 16px; border: 1px solid #171717; border-radius: 8px; font: 650 1rem/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
    .primary { flex: 1; color: #fff; background: #171717; }
    .secondary { color: #171717; background: #fff; }
    .note { color: #555b66; font-size: .92rem; }
    .error { padding: 12px; border: 1px solid #c94343; border-radius: 8px; color: #842626; background: #fff4f4; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize RunComfy MCP</h1>
    <p>Approve only if both the client and callback below are what you expect.</p>
    <div class="identity">
      <strong>${clientName}</strong>
      <code>Callback: ${redirectOrigin}</code>
    </div>
    <p class="note"><strong>Access granted:</strong> all currently available RunComfy MCP tools. This includes viewing deployments, changing or deleting deployments and instances, and submitting requests that may incur usage charges.</p>
    ${error}
    <form method="post" action="${COMPLETE_PATH}" autocomplete="off">
      <input type="hidden" name="session" value="${sessionId}">
      <input type="hidden" name="csrf" value="${csrfToken}">
      <label for="token">RunComfy API token</label>
      <input id="token" name="token" type="password" required minlength="32" maxlength="4096" autocomplete="off" autocapitalize="none" spellcheck="false">
      <p class="note">Copy your current token from <a href="${profileUrl}" target="_blank" rel="noopener noreferrer">RunComfy Profile</a>. It is submitted to this RunComfy authorization service and stored only as encrypted OAuth data; the MCP client never receives it.</p>
      <p class="note">This request expires after 10 minutes. Regenerating the token in RunComfy Profile revokes this connection's upstream access.</p>
      <div class="actions">
        <button class="primary" type="submit" name="action" value="authorize">Authorize</button>
        <button class="secondary" type="submit" name="action" value="cancel" formnovalidate>Cancel</button>
      </div>
    </form>
  </main>
</body>
</html>`;

  return withSecurityHeaders(
    new Response(html, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          `default-src 'none'; style-src 'nonce-${nonce}'; ` +
          `form-action 'self'${options.formActionSource ? ` ${options.formActionSource}` : ""}; ` +
          "base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
      },
    }),
    "strict-origin",
  );
}

function retryPage(message: string, status: 400 | 503 = 503): Response {
  const nonce = randomOpaqueToken(18);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Retry RunComfy authorization</title>
  <style nonce="${nonce}">
    :root { font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f6f7f9; }
    main { max-width: 500px; padding: 30px; border: 1px solid #dedfe3; border-radius: 14px; background: #fff; }
    p { line-height: 1.55; }
  </style>
</head>
<body>
  <main>
    <h1>Start the connection again</h1>
    <p>${escapeHtml(message)}</p>
    <p>Go back to the app you were connecting &mdash; Claude, for example &mdash; and start the connection again from the beginning. Each authorization link works only once, so your browser's Back button will just resubmit the same used link and land you here again.</p>
    <p>You do not need a new API token. The one in your <a href="https://www.runcomfy.com/profile">RunComfy Profile</a> keeps working.</p>
  </main>
</body>
</html>`;
  const response = withSecurityHeaders(
    new Response(html, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; ` +
          "frame-ancestors 'none'; object-src 'none'",
        "retry-after": "2",
      },
    }),
  );
  return response;
}

function methodNotAllowed(allowed: string): Response {
  return withSecurityHeaders(
    new Response("Method not allowed.", {
      status: 405,
      headers: {
        allow: allowed,
        "content-type": "text/plain; charset=utf-8",
      },
    }),
  );
}

function localErrorResponse(message: string, status: number): Response {
  return withSecurityHeaders(
    new Response(message, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );
}

function redirectResponse(location: string): Response {
  return withSecurityHeaders(
    new Response(null, {
      status: 302,
      headers: { location },
    }),
  );
}

function withSecurityHeaders(
  response: Response,
  referrerPolicy: "no-referrer" | "strict-origin" = "no-referrer",
): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("pragma", "no-cache");
  // The consent form uses `strict-origin` because `no-referrer` serializes its
  // same-origin POST's Origin header as `null`. Other responses keep the more
  // restrictive default because they do not submit back to this origin.
  headers.set("referrer-policy", referrerPolicy);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  // These pages are opened by cross-origin OAuth clients. Opt out of COOP
  // isolation so a compatible client can retain its popup reference through
  // consent and the callback redirect. `same-origin-allow-popups` only helps
  // the page that opens a popup; it still isolates this cross-origin page.
  // Exact-origin/CSRF checks, PKCE, CSP and frame denial remain unchanged.
  headers.set("cross-origin-opener-policy", "unsafe-none");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function bridgeKey(sessionId: string): string {
  return `${BRIDGE_KEY_PREFIX}${sessionId}`;
}

async function deleteConsentSession(env: OAuthBridgeEnv, key: string): Promise<void> {
  try {
    await env.OAUTH_KV.delete(key);
  } catch {
    // KV TTL remains the fallback cleanup. No RunComfy token is stored here.
  }
}

function getRedirectOriginLabel(redirectUri: string): string | null {
  try {
    const url = new URL(redirectUri);
    if (url.origin !== "null") return url.origin;
    if (!url.protocol || url.protocol.length > 64) return null;
    return `${url.protocol}//${url.host || "local application"}`;
  } catch {
    return null;
  }
}

/**
 * CSP `form-action` is enforced against the *redirect target* of a form
 * submission, not only the POST target. A consent page restricted to 'self'
 * therefore lets the POST through and then silently blocks the 302 back to the
 * client, so the browser sits on the consent page while the authorization has
 * already been consumed server-side.
 *
 * This returns the client's origin as a CSP source, plus the OpenAI platform
 * origin only for ChatGPT's registered stable callback: that callback redirects
 * again to platform.openai.com/apps-manage/oauth. Chrome checks that next hop
 * against the original form's policy too.
 *
 * Keep these sources separate from getRedirectOriginLabel: that is display
 * text and may contain a space, which would corrupt the header. Only http(s)
 * origins are emitted, which is all client registration accepts.
 */
function formActionSource(redirectUri: string): string | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.origin === "null") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Guards against a host that could corrupt the header: a CSP source is
  // space-delimited, so anything with whitespace (or CR/LF) must not reach it.
  // An IPv6 literal is bracketed and contains colons, so it needs its own
  // branch -- the flat character class silently dropped `http://[::1]:PORT`
  // callbacks, which registration explicitly accepts and advertises.
  if (!/^(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9.\-]+)(?::\d{1,5})?$/.test(url.host)) {
    return null;
  }
  if (
    url.origin === "https://chatgpt.com" &&
    url.pathname === "/connector_platform_oauth_redirect"
  ) {
    return `${url.origin} https://platform.openai.com`;
  }
  return url.origin;
}

function normalizeClientName(value: string | undefined): string {
  const cleaned = (value ?? "MCP client")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "MCP client";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeBearerToken(value: string): boolean {
  return value.length >= 32 && value.length <= 4_096 && /^[\x21-\x7e]+$/.test(value);
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isOpaqueToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function randomOpaqueToken(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

class FormReadError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "FormReadError";
  }
}
