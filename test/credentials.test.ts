import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { credentialsFromRequest } from "../src/credentials.js";

describe("Engagement Cloud request credentials", () => {
  it("accepts the client ID and secret through HTTP Basic authentication", () => {
    const authorization = `Basic ${Buffer.from("my-client:my-secret").toString("base64")}`;
    const request = { headers: { authorization } } as Request;

    const credentials = credentialsFromRequest(request, loadConfig({}));

    expect(credentials.clientId).toBe("my-client");
    expect(credentials.clientSecret).toBe("my-secret");
  });

  it("rejects an expired bearer token so the MCP client reauthorizes", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const expiredToken = `${encode({ alg: "none" })}.${encode({
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    })}.signature`;
    const request = { headers: { authorization: `Bearer ${expiredToken}` } } as Request;

    expect(() => credentialsFromRequest(request, loadConfig({})))
      .toThrow("access token has expired");
  });

  it("accepts a bearer token that has not expired", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const activeToken = `${encode({ alg: "none" })}.${encode({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.signature`;
    const request = { headers: { authorization: `Bearer ${activeToken}` } } as Request;

    expect(credentialsFromRequest(request, loadConfig({})).accessToken).toBe(activeToken);
  });
});
