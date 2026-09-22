const DEFAULT_ALLOWED_SUFFIXES = [
  "emarsys.net",
  "cloud.sap",
  "ondemand.com",
];

function csv(value: string | undefined): string[] {
  return value
    ? value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)
    : [];
}

function integer(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cloudFoundryHosts(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const application = JSON.parse(value) as {
      application_uris?: unknown;
      uris?: unknown;
    };
    const candidates = [application.application_uris, application.uris];
    return candidates
      .flatMap((candidate) => Array.isArray(candidate) ? candidate : [])
      .filter((candidate): candidate is string => typeof candidate === "string")
      .map((candidate) => candidate.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface AppConfig {
  host: string;
  port: number;
  serverApiKey?: string;
  defaultClientId?: string;
  defaultClientSecret?: string;
  defaultBaseUrl: string;
  tokenUrl?: string;
  allowInsecureUrls: boolean;
  allowedEcHosts: string[];
  allowedMcpHosts: string[];
  requestTimeoutMs: number;
  maxResponseBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const allowedMcpHosts = [
    ...csv(env.MCP_ALLOWED_HOSTS),
    ...cloudFoundryHosts(env.VCAP_APPLICATION),
  ];
  return {
    host: env.HOST ?? "127.0.0.1",
    port: integer(env.PORT, 3000),
    serverApiKey: env.MCP_SERVER_API_KEY,
    defaultClientId: env.EC_CLIENT_ID,
    defaultClientSecret: env.EC_CLIENT_SECRET,
    defaultBaseUrl: env.EC_BASE_URL ?? "https://api.emarsys.net/api",
    tokenUrl: env.EC_TOKEN_URL,
    allowInsecureUrls: env.ALLOW_INSECURE_EC_URLS === "true",
    allowedEcHosts: [
      ...DEFAULT_ALLOWED_SUFFIXES,
      ...csv(env.EC_ALLOWED_HOSTS),
    ],
    allowedMcpHosts: [...new Set(allowedMcpHosts)],
    requestTimeoutMs: integer(env.EC_REQUEST_TIMEOUT_MS, 30_000),
    maxResponseBytes: integer(env.EC_MAX_RESPONSE_BYTES, 1_000_000),
  };
}
