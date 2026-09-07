import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import {
  buildForwardedRequest,
  guardRequestBody,
  isAllowedRedirectUri,
  isProviderIssuedToken,
} from "./index";
import {
  handleOAuthBridgeRequest,
  validateRunComfyAccessToken,
  type OAuthBridgeEnv,
} from "./oauth-bridge";

const MCP_URL = "https://mcp.runcomfy.com/mcp";
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: "auth-test",
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "auth-test", version: "1.0" },
  },
});

describe("OAuth boundary", () => {
  it("rejects unauthenticated initialization before the MCP container", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: INITIALIZE,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.runcomfy.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("rejects an unknown provider-shaped token before the MCP container", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer 00000000-0000-8000-8000-000000000000:${"g".repeat(32)}:${"s".repeat(32)}`,
        "content-type": "application/json",
      },
      body: INITIALIZE,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("publishes path-bound protected-resource and authorization-server metadata", async () => {
    const resourceResponse = await SELF.fetch(
      "https://mcp.runcomfy.com/.well-known/oauth-protected-resource/mcp",
    );
    const resource = await resourceResponse.json<Record<string, unknown>>();

    expect(resourceResponse.status).toBe(200);
    expect(resource.resource).toBe(MCP_URL);
    expect(resource.authorization_servers).toEqual(["https://mcp.runcomfy.com"]);

    const serverResponse = await SELF.fetch(
      "https://mcp.runcomfy.com/.well-known/oauth-authorization-server",
    );
    const server = await serverResponse.json<Record<string, unknown>>();

    expect(serverResponse.status).toBe(200);
    expect(server.authorization_endpoint).toBe("https://mcp.runcomfy.com/authorize");
    expect(server.token_endpoint).toBe("https://mcp.runcomfy.com/oauth/token");
    expect(server.registration_endpoint).toBe("https://mcp.runcomfy.com/oauth/register");
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it.each([
    ["missing", undefined, undefined],
    ["plain method", "a".repeat(43), "plain"],
    ["short", "a".repeat(42), "S256"],
    ["invalid character", `${"a".repeat(42)}=`, "S256"],
  ])("rejects %s PKCE before consent", async (_name, codeChallenge, codeChallengeMethod) => {
    const lookupClient = vi.fn();
    const env = {
      OAUTH_KV: {} as KVNamespace,
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn().mockResolvedValue({
          responseType: "code",
          clientId: "test-client",
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
          scope: ["mcp:tools"],
          state: "pkce-state",
          codeChallenge,
          codeChallengeMethod,
          issuer: "https://mcp.runcomfy.com",
        }),
        lookupClient,
      } as unknown as OAuthBridgeEnv["OAUTH_PROVIDER"],
    } satisfies OAuthBridgeEnv;

    const response = await handleOAuthBridgeRequest(
      new Request("https://mcp.runcomfy.com/authorize"),
      env,
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(302);
    const redirect = new URL(response?.headers.get("location") ?? "");
    expect(redirect.origin).toBe("https://claude.ai");
    expect(redirect.searchParams.get("error")).toBe("invalid_request");
    expect(redirect.searchParams.get("state")).toBe("pkce-state");
    expect(lookupClient).not.toHaveBeenCalled();
  });
});

describe("OAuth consent form", () => {
  const authRequest = {
    responseType: "code",
    clientId: "test-client",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    scope: ["mcp:tools"],
    state: "consent-state",
    codeChallenge: "a".repeat(43),
    codeChallengeMethod: "S256",
    issuer: "https://mcp.runcomfy.com",
  };

  function consentEnv(redirectUri = authRequest.redirectUri) {
    const values = new Map<string, string>();
    const request = { ...authRequest, redirectUri };
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", authRequest.state);
    callback.searchParams.set("iss", authRequest.issuer);
    const oauthProvider = {
      parseAuthRequest: vi.fn().mockResolvedValue(request),
      lookupClient: vi.fn().mockResolvedValue({ clientName: "Claude" }),
      completeAuthorization: vi.fn().mockResolvedValue({ redirectTo: callback.toString() }),
    };
    const env = {
      OAUTH_KV: {
        put: vi.fn(async (key: string, value: string) => {
          values.set(key, value);
        }),
        get: vi.fn(async (key: string) => values.get(key) ?? null),
        delete: vi.fn(async (key: string) => {
          values.delete(key);
        }),
      } as unknown as KVNamespace,
      OAUTH_PROVIDER: oauthProvider as unknown as OAuthBridgeEnv["OAUTH_PROVIDER"],
    } satisfies OAuthBridgeEnv;
    return { env, oauthProvider, values, request, callback };
  }

  async function startConsent(env: OAuthBridgeEnv, callbackSources = "https://claude.ai") {
    const response = await handleOAuthBridgeRequest(
      new Request("https://mcp.runcomfy.com/authorize"),
      env,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("referrer-policy")).toBe("strict-origin");
    expect(response?.headers.get("cross-origin-opener-policy")).toBe("unsafe-none");
    // form-action is enforced against the redirect target of the submission,
    // so the client's origin must be allowed or the browser blocks the 302
    // back to it and the user sits on a page that appears to do nothing.
    expect(response?.headers.get("content-security-policy")).toContain(
      `form-action 'self' ${callbackSources};`,
    );
    expect(response?.headers.get("content-security-policy")).toContain("base-uri 'none'");
    expect(response?.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await response!.text();
    const session = html.match(/name="session" value="([^"]+)"/)?.[1];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
    expect(session).toBeTruthy();
    expect(csrf).toBeTruthy();
    return new URLSearchParams({
      action: "cancel",
      session: session!,
      csrf: csrf!,
    }).toString();
  }

  it("completes a same-origin browser form submission", async () => {
    const { env } = consentEnv();
    const body = await startConsent(env);
    const response = await handleOAuthBridgeRequest(
      new Request("https://mcp.runcomfy.com/oauth/authorize/complete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://mcp.runcomfy.com",
        },
        body,
      }),
      env,
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response?.headers.get("cross-origin-opener-policy")).toBe("unsafe-none");
    const redirect = new URL(response?.headers.get("location") ?? "");
    expect(redirect.origin).toBe("https://claude.ai");
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("consent-state");
  });

  it.each([
    ["https://claude.ai/api/mcp/auth_callback", "https://claude.ai"],
    ["https://connect.smithery.ai/oauth/callback", "https://connect.smithery.ai"],
    [
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com https://platform.openai.com",
    ],
  ])("keeps a valid consent-to-callback handoff popup-compatible for %s", async (redirectUri, callbackSources) => {
    const { env, oauthProvider, values, request, callback } = consentEnv(redirectUri);
    const body = new URLSearchParams(await startConsent(env, callbackSources));
    const token = "v".repeat(32);
    body.set("action", "authorize");
    body.set("token", token);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );
    const submit = () => handleOAuthBridgeRequest(
      new Request("https://mcp.runcomfy.com/oauth/authorize/complete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://mcp.runcomfy.com",
        },
        body,
      }),
      env,
    );

    try {
      const response = await submit();
      expect(response?.status).toBe(302);
      expect(response?.headers.get("cross-origin-opener-policy")).toBe("unsafe-none");
      expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response?.headers.get("cache-control")).toBe("no-store, max-age=0");
      expect(response?.headers.get("x-frame-options")).toBe("DENY");
      expect(response?.headers.get("location")).toBe(callback.toString());
      expect(oauthProvider.completeAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          request,
          scope: ["mcp:tools"],
          props: expect.objectContaining({
            authKind: "runcomfy_oauth",
            runcomfyToken: token,
            scopes: ["mcp:tools"],
          }),
        }),
      );
      expect(values.size).toBe(0);

      // A repeated form submission must not issue another authorization code.
      expect((await submit())?.status).toBe(400);
      expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    undefined,
    "null",
    "not a URL",
    "https://auth.mcp.runcomfy.com",
    "https://attacker.example",
  ])(
    "rejects a consent POST with Origin %s",
    async (origin) => {
      const { env } = consentEnv();
      const body = await startConsent(env);
      const headers = new Headers({
        "content-type": "application/x-www-form-urlencoded",
      });
      if (origin !== undefined) headers.set("origin", origin);
      const response = await handleOAuthBridgeRequest(
        new Request("https://mcp.runcomfy.com/oauth/authorize/complete", {
          method: "POST",
          headers,
          body,
        }),
        env,
      );

      expect(response?.status).toBe(403);
      expect(await response?.text()).toBe("Forbidden.");
    },
  );

  it.each([
    "http://mcp.runcomfy.com/oauth/authorize/complete",
    "https://mcp.runcomfy.com:444/oauth/authorize/complete",
  ])("rejects a consent POST to non-canonical target %s", async (target) => {
    const { env } = consentEnv();
    const body = await startConsent(env);
    const response = await handleOAuthBridgeRequest(
      new Request(target, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://mcp.runcomfy.com",
        },
        body,
      }),
      env,
    );

    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe("Forbidden.");
  });

  it("rejects a same-origin consent POST with the wrong CSRF token", async () => {
    const { env } = consentEnv();
    const body = new URLSearchParams(await startConsent(env));
    body.set("csrf", "x".repeat(43));
    const response = await handleOAuthBridgeRequest(
      new Request("https://mcp.runcomfy.com/oauth/authorize/complete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://mcp.runcomfy.com",
        },
        body,
      }),
      env,
    );

    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe("Forbidden.");
  });
});

describe("consent page form-action", () => {
  function envFor(redirectUri: string) {
    return {
      OAUTH_KV: { put: vi.fn(async () => {}) } as unknown as KVNamespace,
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn().mockResolvedValue({
          responseType: "code",
          clientId: "c",
          redirectUri,
          scope: ["mcp:tools"],
          state: "s",
          codeChallenge: "a".repeat(43),
          codeChallengeMethod: "S256",
          issuer: "https://mcp.runcomfy.com",
        }),
        lookupClient: vi.fn().mockResolvedValue({ clientName: "Client" }),
      } as unknown as OAuthBridgeEnv["OAUTH_PROVIDER"],
    } satisfies OAuthBridgeEnv;
  }

  it.each([
    ["https://claude.ai/api/mcp/auth_callback", "form-action 'self' https://claude.ai;"],
    [
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "form-action 'self' https://chatgpt.com https://platform.openai.com;",
    ],
    ["http://localhost:54545/callback", "form-action 'self' http://localhost:54545;"],
    ["http://127.0.0.1:54545/callback", "form-action 'self' http://127.0.0.1:54545;"],
    // Registration accepts and advertises IPv6 loopback, so the CSP has to name
    // it too -- otherwise the browser blocks the 302 back to the local listener
    // and the consent page silently dead-ends after the code is already minted.
    ["http://[::1]:5000/callback", "form-action 'self' http://[::1]:5000;"],
    ["http://[::1]/callback", "form-action 'self' http://[::1];"],
  ])("allows the redirect target for %s", async (redirectUri, expected) => {
    const response = await handleOAuthBridgeRequest(
      new Request("https://mcp.runcomfy.com/authorize"),
      envFor(redirectUri),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-security-policy")).toContain(expected);
  });

  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "http://localhost:54545/callback",
    "http://127.0.0.1:54545/callback",
    "http://[::1]:5000/callback",
  ])(
    "never emits a form-action source with a space-separated injection for %s",
    async (redirectUri) => {
      const response = await handleOAuthBridgeRequest(
        new Request("https://mcp.runcomfy.com/authorize"),
        envFor(redirectUri),
      );
      const csp = response?.headers.get("content-security-policy") ?? "";
      const formAction = csp.split("form-action ")[1]?.split(";")[0] ?? "";
      // Exactly 'self' plus this client's own origin -- no third source, and in
      // particular never the OpenAI platform origin granted to ChatGPT alone.
      expect(formAction.split(" ").length).toBe(2);
      expect(formAction).not.toContain("platform.openai.com");
    },
  );

  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/other_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect/extra",
    "https://chatgpt.com.example/connector_platform_oauth_redirect",
    "https://other.example/connector_platform_oauth_redirect",
    "https://chatgpt.com:8443/connector_platform_oauth_redirect",
    "http://chatgpt.com/connector_platform_oauth_redirect",
  ])("does not allow the OpenAI platform handoff for %s", async (redirectUri) => {
    const response = await handleOAuthBridgeRequest(
      new Request("https://mcp.runcomfy.com/authorize"),
      envFor(redirectUri),
    );

    const csp = response?.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`form-action 'self' ${new URL(redirectUri).origin};`);
    expect(csp).not.toContain("https://platform.openai.com");
  });

  it("never emits a source that would corrupt the header", async () => {
    const response = await handleOAuthBridgeRequest(
      new Request("https://mcp.runcomfy.com/authorize"),
      envFor("weird-scheme:opaque"),
    );

    const csp = response?.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self';");
    expect(csp).not.toContain("local application");
  });
});

describe("consumed consent session", () => {
  function env(stored: string | null) {
    return {
      OAUTH_KV: {
        get: vi.fn(async () => stored),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as KVNamespace,
      OAUTH_PROVIDER: {} as unknown as OAuthBridgeEnv["OAUTH_PROVIDER"],
    } satisfies OAuthBridgeEnv;
  }

  async function submit(stored: string | null) {
    return handleOAuthBridgeRequest(
      new Request("https://mcp.runcomfy.com/oauth/authorize/complete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://mcp.runcomfy.com",
        },
        body: new URLSearchParams({
          action: "authorize",
          session: "s".repeat(43),
          csrf: "c".repeat(43),
          token: "t".repeat(48),
        }).toString(),
      }),
      env(stored),
    );
  }

  // A consent session is deleted once the authorization completes, so
  // resubmitting that page is the common way to land here. Telling the user to
  // press Back sends them to the same used link forever.
  it("sends the user back to the client instead of the Back button", async () => {
    const response = await submit(null);
    const html = (await response?.text()) ?? "";

    expect(response?.status).toBe(400);
    expect(html).toContain("no longer valid");
    expect(html).toContain("start the connection again");
    expect(html).not.toContain("still being prepared");
    expect(html).not.toMatch(/Back button, re-enter/);
  });

  it("keeps a storage outage a retryable 503", async () => {
    const failing = {
      OAUTH_KV: {
        get: vi.fn(async () => {
          throw new Error("kv down");
        }),
      } as unknown as KVNamespace,
      OAUTH_PROVIDER: {} as unknown as OAuthBridgeEnv["OAUTH_PROVIDER"],
    } satisfies OAuthBridgeEnv;

    const response = await handleOAuthBridgeRequest(
      new Request("https://mcp.runcomfy.com/oauth/authorize/complete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://mcp.runcomfy.com",
        },
        body: new URLSearchParams({
          action: "authorize",
          session: "s".repeat(43),
          csrf: "c".repeat(43),
          token: "t".repeat(48),
        }).toString(),
      }),
      failing,
    );

    expect(response?.status).toBe(503);
  });
});

describe("OAuth endpoint body limits", () => {
  it.each(["/oauth/token", "/oauth/register"])(
    "rejects an oversized POST to %s",
    async (path) => {
      const response = await SELF.fetch(`https://mcp.runcomfy.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `payload=${"x".repeat(16 * 1024)}`,
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    },
  );

  it("caps a streamed token body when Content-Length is absent", async () => {
    const chunks = [new Uint8Array(9_000), new Uint8Array(9_000)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const request = new Request("https://mcp.runcomfy.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    request.headers.delete("content-length");

    const response = await SELF.fetch(request);

    expect(response.status).toBe(413);
  });

  it("passes an ordinary token request through to OAuthProvider", async () => {
    const response = await SELF.fetch("https://mcp.runcomfy.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=invalid",
    });

    expect(response.status).not.toBe(413);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });
});

describe("RunComfy token validation", () => {
  it("classifies a non-JSON 401 response as an invalid token", async () => {
    const errorBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("Unauthorized"));
      },
      cancel() {
        throw new Error("runtime refused to cancel the error stream");
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(errorBody, { status: 401 }));

    try {
      await expect(
        validateRunComfyAccessToken("x".repeat(32), null),
      ).resolves.toEqual({ ok: false, kind: "invalid" });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.runcomfy.net/prod/v2/deployments",
        expect.objectContaining({ redirect: "manual" }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("derives a stable pseudonymous subject from a valid primary-API token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    try {
      const token = "v".repeat(32);
      const validation = await validateRunComfyAccessToken(token, null);

      expect(validation.ok).toBe(true);
      if (!validation.ok) throw new Error("expected valid token result");
      expect(validation.userId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      await expect(
        validateRunComfyAccessToken(
          token,
          "00000000-0000-8000-8000-000000000000",
        ),
      ).resolves.toEqual({ ok: false, kind: "invalid" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not follow redirects from the fixed primary API", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/collect" },
        }),
      );

    try {
      await expect(
        validateRunComfyAccessToken("r".repeat(32), null),
      ).resolves.toEqual({ ok: false, kind: "unavailable" });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.runcomfy.net/prod/v2/deployments",
        expect.objectContaining({ redirect: "manual" }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("bounded MCP body reader", () => {
  it("rejects a streamed body that crosses the configured limit", async () => {
    const chunks = [new Uint8Array(600), new Uint8Array(500)];
    const request = new Request(MCP_URL, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      }),
    });
    request.headers.delete("content-length");

    const guarded = await guardRequestBody(
      request,
      1_024,
      (status) => new Response(null, { status }),
    );

    expect(guarded.ok).toBe(false);
    if (!guarded.ok) expect(guarded.response.status).toBe(413);
  });

  it("rebuilds an in-limit streamed body without changing its method or URL", async () => {
    const payload = new TextEncoder().encode(INITIALIZE);
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload.slice(0, 20));
          controller.enqueue(payload.slice(20));
          controller.close();
        },
      }),
    });
    request.headers.delete("content-length");

    const guarded = await guardRequestBody(
      request,
      1_024,
      (status) => new Response(null, { status }),
    );

    expect(guarded.ok).toBe(true);
    if (guarded.ok) {
      expect(guarded.request.method).toBe("POST");
      expect(guarded.request.url).toBe(MCP_URL);
      expect(guarded.request.headers.get("content-type")).toBe("application/json");
      expect(await guarded.request.text()).toBe(INITIALIZE);
    }
  });

  it("also rejects an oversized streamed DELETE body", async () => {
    const request = new Request(MCP_URL, {
      method: "DELETE",
      body: new Uint8Array(1_025),
    });
    request.headers.delete("content-length");

    const guarded = await guardRequestBody(
      request,
      1_024,
      (status) => new Response(null, { status }),
    );

    expect(guarded.ok).toBe(false);
    if (!guarded.ok) expect(guarded.response.status).toBe(413);
  });
});

describe("container forwarding boundary", () => {
  it("strips all caller credentials and rebuilds the internal identity header", () => {
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: {
        authorization: "Bearer oauth-access-token",
        "x-mcp-secret": "legacy-secret",
        "x-runcomfy-user-token": "spoofed-user-token",
        "x-runcomfy-user-token-fingerprint": "spoofed-fingerprint",
      },
      body: INITIALIZE,
    });

    const forwarded = buildForwardedRequest(request, "request-id", "validated-runcomfy-token");

    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(forwarded.headers.get("x-mcp-secret")).toBeNull();
    expect(forwarded.headers.get("x-runcomfy-user-token-fingerprint")).toBeNull();
    expect(forwarded.headers.get("x-runcomfy-user-token")).toBe("validated-runcomfy-token");
    expect(forwarded.headers.get("x-request-id")).toBe("request-id");
  });
});

describe("direct RunComfy API token auth", () => {
  function initializeRequest(token: string): RequestInit {
    return {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: INITIALIZE,
    };
  }

  it("separates provider-issued tokens from RunComfy Profile tokens", () => {
    expect(isProviderIssuedToken("user:grant:secret")).toBe(true);
    expect(isProviderIssuedToken("MzAyM2RiMDgtMWUyYS00OTdmLWJjMzYtMWQzODBhYjI5Y2Zi")).toBe(false);
    expect(isProviderIssuedToken("a:b")).toBe(false);
    expect(isProviderIssuedToken("a:b:c:d")).toBe(false);
  });

  it("answers a rejected RunComfy token with actionable 401 guidance", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    try {
      const response = await SELF.fetch(MCP_URL, initializeRequest("n".repeat(48)));

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
      const body = await response.json<Record<string, string>>();
      expect(body.error).toBe("invalid_token");
      expect(body.error_description).toContain("https://www.runcomfy.com/profile");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects a too-short token without calling the RunComfy API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    try {
      const response = await SELF.fetch(MCP_URL, initializeRequest("short"));

      expect(response.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("passes a valid RunComfy token through the auth boundary to the container", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    try {
      const response = await SELF.fetch(MCP_URL, initializeRequest("v".repeat(48)));

      // The container is not runnable under the test pool, so reaching the
      // proxy (502) is the observable proof that authentication succeeded.
      expect(response.status).not.toBe(401);
      expect(response.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.runcomfy.net/prod/v2/deployments",
        expect.objectContaining({ redirect: "manual" }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("surfaces an upstream outage as a retryable 503", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    try {
      const response = await SELF.fetch(MCP_URL, initializeRequest("u".repeat(48)));

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("dynamic client registration policy", () => {
  it.each([
    "http://localhost:33418/callback",
    "http://127.0.0.1:8976/oauth/callback",
    "http://[::1]:5000/callback",
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://connect.smithery.ai/oauth/callback",
  ])("accepts the redirect URI %s", (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(true);
  });

  it.each([
    "https://attacker.example/callback",
    "https://chatgpt.com/connector/oauth/abc123",
    "https://chatgpt.com.attacker.example/connector_platform_oauth_redirect",
    "https://connect.smithery.ai.attacker.example/oauth/callback",
    "https://connect.smithery.ai/oauth/callback/other",
    "https://connect.smithery.ai/oauth/callback?redirect=https://attacker.example",
    "https://connect.smithery.ai/oauth/callback#fragment",
    "https://attacker@connect.smithery.ai/oauth/callback",
    "http://connect.smithery.ai/oauth/callback",
    "http://localhost.attacker.example/callback",
    "https://localhost:3000/callback#fragment",
    "http://127.0.0.1:8976/callback#fragment",
    "not a url",
    "",
    42,
    null,
  ])("rejects the redirect URI %s", (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false);
  });

  it("meets the RFC 9207 preconditions for ChatGPT's stable redirect URI", async () => {
    const serverResponse = await SELF.fetch(
      "https://mcp.runcomfy.com/.well-known/oauth-authorization-server",
    );
    const server = await serverResponse.json<Record<string, unknown>>();
    const resourceResponse = await SELF.fetch(
      "https://mcp.runcomfy.com/.well-known/oauth-protected-resource/mcp",
    );
    const resource = await resourceResponse.json<Record<string, unknown>>();

    // ChatGPT falls back to a per-connector callback URI unless the
    // authorization server identifies itself per RFC 9207 and both metadata
    // documents name the exact same issuer.
    expect(server.authorization_response_iss_parameter_supported).toBe(true);
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
    expect(resource.authorization_servers).toEqual([server.issuer]);
  });

  it("registers a ChatGPT connector", async () => {
    const response = await SELF.fetch("https://mcp.runcomfy.com/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    expect(response.status).toBe(201);
  });

  it("registers a Claude Code style loopback client", async () => {
    const response = await SELF.fetch("https://mcp.runcomfy.com/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code",
        redirect_uris: ["http://localhost:33418/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json<Record<string, unknown>>();
    expect(body.client_id).toBeTruthy();
    expect(body.redirect_uris).toEqual(["http://localhost:33418/callback"]);
  });

  it("registers the exact Smithery Connect callback", async () => {
    const response = await SELF.fetch("https://mcp.runcomfy.com/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Smithery Connect",
        redirect_uris: ["https://connect.smithery.ai/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json<Record<string, unknown>>();
    expect(body.client_id).toBeTruthy();
    expect(body.redirect_uris).toEqual(["https://connect.smithery.ai/oauth/callback"]);
  });

  it("refuses an extra unapproved callback in a Smithery registration", async () => {
    const response = await SELF.fetch("https://mcp.runcomfy.com/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Smithery Connect",
        redirect_uris: [
          "https://connect.smithery.ai/oauth/callback",
          "https://connect.smithery.ai/oauth/callback/other",
        ],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("still refuses an off-host redirect URI", async () => {
    const response = await SELF.fetch("https://mcp.runcomfy.com/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Totally RunComfy",
        redirect_uris: ["https://attacker.example/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
  });
});
