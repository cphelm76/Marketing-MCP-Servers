import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { EngagementCloudCredentials } from "../src/credentials.js";
import { EngagementCloudClient } from "../src/engagement-cloud-client.js";
import { TokenManager } from "../src/token-manager.js";

describe("EngagementCloudClient", () => {
  let server: Server;
  let origin: string;
  let tokenCalls: number;
  let apiCalls: number;

  beforeEach(async () => {
    tokenCalls = 0;
    apiCalls = 0;
    server = createServer((req, res) => {
      if (req.url === "/oauth2/token") {
        tokenCalls += 1;
        expect(req.headers.authorization).toBe(
          `Basic ${Buffer.from("client:secret").toString("base64")}`,
        );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: `token-${tokenCalls}`, expires_in: 3600 }));
        return;
      }

      apiCalls += 1;
      expect(req.headers.authorization).toBe("Bearer token-1");
      res.setHeader("content-type", "application/json");
      res.setHeader("x-request-id", "request-123");
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("uses Basic auth for OAuth, Bearer auth for API calls, and caches tokens", async () => {
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 3000,
      defaultBaseUrl: `${origin}/api`,
      allowInsecureUrls: true,
      allowedEcHosts: ["127.0.0.1"],
      allowedMcpHosts: [],
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
    };
    const credentials: EngagementCloudCredentials = {
      clientId: "client",
      clientSecret: "secret",
      baseUrl: new URL(config.defaultBaseUrl),
    };
    const tokens = new TokenManager(config, new URL(`${origin}/oauth2/token`));
    const client = new EngagementCloudClient(credentials, tokens, config);

    const first = await client.request({
      method: "GET",
      path: "/v3/settings",
      query: { limit: 5, field: ["email", "firstName"] },
    });
    const second = await client.request({ method: "GET", path: "v3/contact/fields" });

    expect(first).toEqual({
      status: 200,
      requestId: "request-123",
      data: { path: "/api/v3/settings?limit=5&field=email&field=firstName" },
    });
    expect(second.status).toBe(200);
    expect(tokenCalls).toBe(1);
    expect(apiCalls).toBe(2);
  });

  it("tests the API connection rather than only obtaining a token", async () => {
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 3000,
      defaultBaseUrl: `${origin}/api`,
      allowInsecureUrls: true,
      allowedEcHosts: ["127.0.0.1"],
      allowedMcpHosts: [],
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
    };
    const credentials: EngagementCloudCredentials = {
      clientId: "client",
      clientSecret: "secret",
      baseUrl: new URL(config.defaultBaseUrl),
    };
    const client = new EngagementCloudClient(
      credentials,
      new TokenManager(config, new URL(`${origin}/oauth2/token`)),
      config,
    );

    await expect(client.testConnection()).resolves.toEqual({
      connected: true,
      baseUrl: `${origin}/api`,
    });
    expect(tokenCalls).toBe(1);
    expect(apiCalls).toBe(1);
  });

  it("rejects absolute request URLs", async () => {
    const config = {
      host: "127.0.0.1",
      port: 3000,
      defaultBaseUrl: `${origin}/api`,
      allowInsecureUrls: true,
      allowedEcHosts: ["127.0.0.1"],
      allowedMcpHosts: [],
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
    } satisfies AppConfig;
    const credentials: EngagementCloudCredentials = {
      clientId: "client",
      clientSecret: "secret",
      baseUrl: new URL(config.defaultBaseUrl),
    };
    const client = new EngagementCloudClient(
      credentials,
      new TokenManager(config, new URL(`${origin}/oauth2/token`)),
      config,
    );

    await expect(client.request({ method: "GET", path: "https://example.com/steal" }))
      .rejects.toThrow("relative API path");
  });
});
