import type { AppConfig } from "./config.js";
import type { EngagementCloudCredentials } from "./credentials.js";
import { ServiceError } from "./errors.js";
import type { AccessTokenProvider } from "./token-manager.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | Array<string | number | boolean>;

export interface ApiRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  requestId?: string;
  data: unknown;
}

function buildUrl(baseUrl: URL, path: string, query?: Record<string, QueryValue>): URL {
  if (!path || path.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new ServiceError("path must be a non-empty relative API path, not a URL.");
  }

  const base = baseUrl.href.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  const url = new URL(`${base}/${normalizedPath}`);

  for (const [name, rawValue] of Object.entries(query ?? {})) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) url.searchParams.append(name, String(value));
  }
  return url;
}

async function readResponse(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ServiceError(`Engagement Cloud response exceeds ${maxBytes} bytes.`, 502);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new ServiceError(`Engagement Cloud response exceeds ${maxBytes} bytes.`, 502);
  }
  if (bytes.byteLength === 0) return null;

  const text = new TextDecoder().decode(bytes);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export class EngagementCloudClient {
  constructor(
    private readonly credentials: EngagementCloudCredentials,
    private readonly tokens: AccessTokenProvider,
    private readonly config: AppConfig,
  ) {}

  async testConnection(): Promise<{ connected: true; baseUrl: string }> {
    // A successful token exchange only proves that the client credentials are
    // valid. Verify that the resulting bearer token is also accepted by the
    // Engagement Cloud API so expired or otherwise unusable Joule tokens do
    // not produce a false-positive connection test.
    await this.request({ method: "GET", path: "v3/settings" });
    return { connected: true, baseUrl: this.credentials.baseUrl.href };
  }

  async request(input: ApiRequest): Promise<ApiResponse> {
    const url = buildUrl(this.credentials.baseUrl, input.path, input.query);
    let token = await this.tokens.get(this.credentials);
    let response = await this.fetch(input, url, token);

    if (response.status === 401) {
      this.tokens.invalidate(this.credentials);
      token = await this.tokens.get(this.credentials, true);
      response = await this.fetch(input, url, token);
    }

    const data = await readResponse(response, this.config.maxResponseBytes);
    const result: ApiResponse = {
      status: response.status,
      requestId: response.headers.get("x-request-id") ??
        response.headers.get("x-correlation-id") ?? undefined,
      data,
    };

    console.info(JSON.stringify({
      event: "engagement_cloud_api_response",
      method: input.method,
      path: url.pathname,
      status: response.status,
      ...(result.requestId ? { requestId: result.requestId } : {}),
    }));

    if (!response.ok) {
      throw new ServiceError(
        `Engagement Cloud API request failed with HTTP ${response.status}.`,
        response.status === 401 ? 401 : 502,
        result,
      );
    }
    return result;
  }

  private async fetch(input: ApiRequest, url: URL, token: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      return await fetch(url, {
        method: input.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? "Engagement Cloud API request timed out."
        : "Could not reach the Engagement Cloud API.";
      console.warn(JSON.stringify({
        event: "engagement_cloud_api_network_error",
        method: input.method,
        path: url.pathname,
        error: message,
      }));
      throw new ServiceError(message, 502);
    } finally {
      clearTimeout(timer);
    }
  }
}
