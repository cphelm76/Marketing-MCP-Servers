import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, Router } from "express";
import type { AppConfig } from "./config.js";
import { ENGAGEMENT_CLOUD_TOKEN_URL } from "./token-manager.js";

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
}

interface EmarsysTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function refreshTokenFor(clientId: string, clientSecret: string): string {
  return createHmac("sha256", clientSecret)
    .update("sap-engagement-cloud-mcp-refresh\0")
    .update(clientId)
    .digest("base64url");
}

function validRefreshToken(token: string, clientId: string, clientSecret: string): boolean {
  const supplied = Buffer.from(token);
  const expected = Buffer.from(refreshTokenFor(clientId, clientSecret));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const authorizationCodes = new Map<string, AuthorizationCode>();

export function externalOrigin(req: Request): string {
  const forwarded = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwarded || req.protocol || "https";
  return `${protocol}://${req.get("host")}`;
}

function loopbackRedirect(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol === "http:" && isLoopback ? url : undefined;
  } catch {
    return undefined;
  }
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

function tokenClientCredentials(req: Request): { clientId?: string; clientSecret?: string } {
  const authorization = req.header("authorization");
  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        return {
          clientId: decoded.slice(0, separator),
          clientSecret: decoded.slice(separator + 1),
        };
      }
    } catch {
      // Fall through to form credentials.
    }
  }
  return {
    clientId: typeof req.body?.client_id === "string" ? req.body.client_id : undefined,
    clientSecret: typeof req.body?.client_secret === "string" ? req.body.client_secret : undefined,
  };
}

export type EmarsysTokenExchange = (
  clientId: string,
  clientSecret: string,
  config: AppConfig,
) => Promise<{ status: number; payload: EmarsysTokenResponse }>;

async function exchangeEmarsysToken(
  clientId: string,
  clientSecret: string,
  config: AppConfig,
): Promise<{ status: number; payload: EmarsysTokenResponse }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const tokenUrl = new URL(config.tokenUrl ?? ENGAGEMENT_CLOUD_TOKEN_URL.href);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as EmarsysTokenResponse;
    return { status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

export function registerOAuthBridge(
  router: Router,
  config: AppConfig,
  tokenExchange: EmarsysTokenExchange = exchangeEmarsysToken,
): void {
  const protectedResource = (req: Request, res: Response) => {
    const origin = externalOrigin(req);
    res.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["openid"],
      bearer_methods_supported: ["header"],
    });
  };

  router.get("/.well-known/oauth-protected-resource", protectedResource);
  router.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  router.get("/.well-known/oauth-authorization-server", (req, res) => {
    const origin = externalOrigin(req);
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      scopes_supported: ["openid"],
    });
  });

  router.get("/authorize", (req, res) => {
    const responseType = req.query.response_type;
    const clientId = req.query.client_id;
    const redirectUri = req.query.redirect_uri;
    const codeChallenge = req.query.code_challenge;
    const challengeMethod = req.query.code_challenge_method;
    const state = req.query.state;
    const scope = typeof req.query.scope === "string" ? req.query.scope : "openid";

    if (
      responseType !== "code" ||
      typeof clientId !== "string" ||
      typeof redirectUri !== "string" ||
      typeof codeChallenge !== "string" ||
      challengeMethod !== "S256" ||
      !loopbackRedirect(redirectUri)
    ) {
      oauthError(res, 400, "invalid_request", "A loopback redirect URI and PKCE S256 are required.");
      return;
    }

    const code = randomBytes(32).toString("base64url");
    authorizationCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      scope,
      expiresAt: Date.now() + 5 * 60_000,
    });

    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    if (typeof state === "string") callback.searchParams.set("state", state);
    res.redirect(302, callback.href);
  });

  router.post("/token", async (req, res) => {
    const grantType = req.body?.grant_type;
    const credentials = tokenClientCredentials(req);

    if (grantType === "refresh_token") {
      const refreshToken = req.body?.refresh_token;
      if (!credentials.clientId || !credentials.clientSecret) {
        oauthError(res, 401, "invalid_client", "Client ID and client secret are required.");
        return;
      }
      if (
        typeof refreshToken !== "string" ||
        !validRefreshToken(refreshToken, credentials.clientId, credentials.clientSecret)
      ) {
        oauthError(res, 400, "invalid_grant", "The refresh token is invalid.");
        return;
      }

      try {
        const emarsys = await tokenExchange(
          credentials.clientId,
          credentials.clientSecret,
          config,
        );
        if (
          emarsys.status < 200 ||
          emarsys.status >= 300 ||
          typeof emarsys.payload.access_token !== "string"
        ) {
          oauthError(res, 401, "invalid_client", "Emarsys rejected the client credentials.");
          return;
        }

        res.setHeader("cache-control", "no-store");
        res.setHeader("pragma", "no-cache");
        console.info(JSON.stringify({
          event: "engagement_cloud_oauth_token_issued",
          grantType: "refresh_token",
          expiresIn: typeof emarsys.payload.expires_in === "number"
            ? emarsys.payload.expires_in
            : 3600,
        }));
        res.json({
          access_token: emarsys.payload.access_token,
          token_type: typeof emarsys.payload.token_type === "string"
            ? emarsys.payload.token_type
            : "Bearer",
          expires_in: typeof emarsys.payload.expires_in === "number"
            ? emarsys.payload.expires_in
            : 3600,
          refresh_token: refreshToken,
          scope: "openid",
        });
      } catch {
        oauthError(res, 502, "temporarily_unavailable", "Could not reach the Emarsys token endpoint.");
      }
      return;
    }

    const code = req.body?.code;
    const redirectUri = req.body?.redirect_uri;
    const codeVerifier = req.body?.code_verifier;
    if (
      grantType !== "authorization_code" ||
      typeof code !== "string" ||
      typeof redirectUri !== "string" ||
      typeof codeVerifier !== "string"
    ) {
      oauthError(res, 400, "invalid_request", "Missing authorization-code or PKCE parameters.");
      return;
    }

    const authorization = authorizationCodes.get(code);
    authorizationCodes.delete(code);
    const verifierHash = createHash("sha256").update(codeVerifier).digest("base64url");
    if (
      !authorization ||
      authorization.expiresAt <= Date.now() ||
      authorization.redirectUri !== redirectUri ||
      authorization.codeChallenge !== verifierHash ||
      credentials.clientId !== authorization.clientId
    ) {
      oauthError(res, 400, "invalid_grant", "The authorization code or PKCE verifier is invalid.");
      return;
    }
    if (!credentials.clientId || !credentials.clientSecret) {
      oauthError(res, 401, "invalid_client", "Client ID and client secret are required.");
      return;
    }

    try {
      const emarsys = await tokenExchange(
        credentials.clientId,
        credentials.clientSecret,
        config,
      );
      if (
        emarsys.status < 200 ||
        emarsys.status >= 300 ||
        typeof emarsys.payload.access_token !== "string"
      ) {
        oauthError(res, 401, "invalid_client", "Emarsys rejected the client credentials.");
        return;
      }

      res.setHeader("cache-control", "no-store");
      res.setHeader("pragma", "no-cache");
      console.info(JSON.stringify({
        event: "engagement_cloud_oauth_token_issued",
        grantType: "authorization_code",
        expiresIn: typeof emarsys.payload.expires_in === "number"
          ? emarsys.payload.expires_in
          : 3600,
      }));
      res.json({
        access_token: emarsys.payload.access_token,
        token_type: typeof emarsys.payload.token_type === "string"
          ? emarsys.payload.token_type
          : "Bearer",
        expires_in: typeof emarsys.payload.expires_in === "number"
          ? emarsys.payload.expires_in
          : 3600,
        refresh_token: refreshTokenFor(credentials.clientId, credentials.clientSecret),
        scope: authorization.scope,
      });
    } catch {
      oauthError(res, 502, "temporarily_unavailable", "Could not reach the Emarsys token endpoint.");
    }
  });
}
