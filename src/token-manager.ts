import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { EngagementCloudCredentials } from "./credentials.js";
import { ServiceError } from "./errors.js";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
}

export const ENGAGEMENT_CLOUD_TOKEN_URL = new URL(
  "https://auth.emarsys.net/oauth2/token",
);

export interface AccessTokenProvider {
  get(credentials: EngagementCloudCredentials, forceRefresh?: boolean): Promise<string>;
  invalidate(credentials: EngagementCloudCredentials): void;
}

export class TokenManager implements AccessTokenProvider {
  private readonly cache = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly tokenUrl: URL;

  constructor(
    private readonly config: AppConfig,
    tokenUrl?: URL,
  ) {
    this.tokenUrl = tokenUrl ?? new URL(config.tokenUrl ?? ENGAGEMENT_CLOUD_TOKEN_URL.href);
  }

  private key(credentials: EngagementCloudCredentials): string {
    return createHash("sha256")
      .update(credentials.clientId)
      .update("\0")
      .update(credentials.clientSecret)
      .update("\0")
      .update(this.tokenUrl.href)
      .digest("hex");
  }

  async get(credentials: EngagementCloudCredentials, forceRefresh = false): Promise<string> {
    const key = this.key(credentials);
    const cached = this.cache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.accessToken;
    }

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const request = this.fetchToken(credentials, key).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  invalidate(credentials: EngagementCloudCredentials): void {
    this.cache.delete(this.key(credentials));
  }

  private async fetchToken(credentials: EngagementCloudCredentials, key: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(this.tokenUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`,
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? "Engagement Cloud token request timed out."
        : "Could not reach the Engagement Cloud token endpoint.";
      throw new ServiceError(message, 502);
    } finally {
      clearTimeout(timer);
    }

    const payload = await response.json().catch(() => undefined) as TokenResponse | undefined;
    if (!response.ok) {
      throw new ServiceError(
        `Engagement Cloud token request failed with HTTP ${response.status}.`,
        502,
        { status: response.status },
      );
    }
    if (!payload || typeof payload.access_token !== "string") {
      throw new ServiceError("The token endpoint response did not contain an access_token.", 502);
    }

    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 300;
    this.cache.set(key, {
      accessToken: payload.access_token,
      expiresAt: Date.now() + Math.max(expiresIn, 60) * 1000,
    });
    return payload.access_token;
  }
}

export class FixedAccessTokenProvider implements AccessTokenProvider {
  constructor(private readonly accessToken: string) {}

  async get(): Promise<string> {
    return this.accessToken;
  }

  invalidate(): void {
    // Joule obtains a new token by repeating the MCP OAuth flow.
  }
}
