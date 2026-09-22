import type { Request } from "express";
import type { AppConfig } from "./config.js";
import { ServiceError } from "./errors.js";

export interface EngagementCloudCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  baseUrl: URL;
}

interface JwtTiming {
  expiresAt?: number;
  issuedAt?: number;
}

function jwtTiming(token: string): JwtTiming | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
      iat?: unknown;
    };
    return {
      ...(typeof payload.exp === "number" ? { expiresAt: payload.exp } : {}),
      ...(typeof payload.iat === "number" ? { issuedAt: payload.iat } : {}),
    };
  } catch {
    return undefined;
  }
}

function singleHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function basicCredentials(req: Request): { clientId: string; clientSecret: string } | undefined {
  const authorization = singleHeader(req, "authorization");
  if (!authorization?.startsWith("Basic ")) return undefined;

  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator <= 0) return undefined;
    const clientId = decoded.slice(0, separator);
    const clientSecret = decoded.slice(separator + 1);
    return clientSecret ? { clientId, clientSecret } : undefined;
  } catch {
    return undefined;
  }
}

function isAllowedHost(hostname: string, allowed: string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => {
    const allowedHost = entry.replace(/^\./, "").replace(/\.$/, "");
    return normalized === allowedHost || normalized.endsWith(`.${allowedHost}`);
  });
}

function validatedUrl(value: string, label: string, config: AppConfig): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceError(`${label} must be a valid absolute URL.`);
  }

  if (url.protocol !== "https:" && !(config.allowInsecureUrls && url.protocol === "http:")) {
    throw new ServiceError(`${label} must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new ServiceError(`${label} must not contain embedded credentials.`);
  }
  if (!isAllowedHost(url.hostname, config.allowedEcHosts)) {
    throw new ServiceError(
      `${label} host is not allowed. Add an exact host or parent suffix to EC_ALLOWED_HOSTS if this is your SAP tenant.`,
    );
  }
  return url;
}

export function credentialsFromRequest(
  req: Request,
  config: AppConfig,
): EngagementCloudCredentials {
  const authorization = singleHeader(req, "authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : undefined;
  const basic = basicCredentials(req);
  const clientId = singleHeader(req, "x-ec-client-id") ?? basic?.clientId ?? config.defaultClientId;
  const clientSecret = singleHeader(req, "x-ec-client-secret") ?? basic?.clientSecret ?? config.defaultClientSecret;
  const baseUrl = singleHeader(req, "x-ec-base-url") ?? config.defaultBaseUrl;

  if (!bearerToken && (!clientId || !clientSecret)) {
    throw new ServiceError(
      "Missing Engagement Cloud credentials. Send X-EC-Client-Id and X-EC-Client-Secret headers or HTTP Basic authentication.",
      401,
    );
  }

  if (bearerToken) {
    const timing = jwtTiming(bearerToken);
    const now = Math.floor(Date.now() / 1000);
    if (timing?.expiresAt !== undefined && timing.expiresAt <= now + 30) {
      console.warn(JSON.stringify({
        event: "engagement_cloud_expired_bearer_rejected",
        expiresAt: new Date(timing.expiresAt * 1000).toISOString(),
        ...(timing.issuedAt === undefined
          ? {}
          : { issuedAt: new Date(timing.issuedAt * 1000).toISOString() }),
      }));
      throw new ServiceError(
        "The Engagement Cloud access token has expired. Reauthorize the MCP connector.",
        401,
      );
    }
  }

  return {
    clientId: clientId ?? "",
    clientSecret: clientSecret ?? "",
    ...(bearerToken ? { accessToken: bearerToken } : {}),
    baseUrl: validatedUrl(baseUrl, "Base URL", config),
  };
}
