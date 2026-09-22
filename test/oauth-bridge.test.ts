import { createHash } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { registerOAuthBridge } from "../src/oauth-bridge.js";

describe("Joule OAuth bridge", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
  });

  it("publishes metadata and exchanges an authorization code with PKCE", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    let exchangeCount = 0;
    registerOAuthBridge(app, loadConfig({}), async (clientId, clientSecret) => {
      expect(clientId).toBe("emarsys-client");
      expect(clientSecret).toBe("emarsys-secret");
      exchangeCount += 1;
      return {
        status: 200,
        payload: { access_token: `emarsys-access-token-${exchangeCount}`, token_type: "Bearer", expires_in: 3600 },
      };
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test address");
    const origin = `http://127.0.0.1:${address.port}`;

    const metadata = await fetch(`${origin}/.well-known/oauth-authorization-server`).then((res) => res.json());
    expect(metadata).toMatchObject({
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      grant_types_supported: ["authorization_code", "refresh_token"],
    });

    const verifier = "a-secure-pkce-verifier-with-more-than-forty-three-characters";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${origin}/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: "emarsys-client",
      redirect_uri: "http://localhost:18766/mcp-callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test-state",
      scope: "openid",
    }).toString();
    const authorization = await fetch(authorize, { redirect: "manual" });
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get("location") ?? "");
    expect(callback.searchParams.get("state")).toBe("test-state");

    const token = await fetch(`${origin}/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("emarsys-client:emarsys-secret").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") ?? "",
        redirect_uri: "http://localhost:18766/mcp-callback",
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    const initialToken = await token.json() as Record<string, unknown>;
    expect(initialToken).toMatchObject({
      access_token: "emarsys-access-token-1",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid",
    });
    expect(initialToken.refresh_token).toEqual(expect.any(String));

    const refreshed = await fetch(`${origin}/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("emarsys-client:emarsys-secret").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: String(initialToken.refresh_token),
      }),
    });
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      access_token: "emarsys-access-token-2",
      refresh_token: initialToken.refresh_token,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid",
    });
  });
});
