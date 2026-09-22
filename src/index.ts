import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { loadConfig } from "./config.js";
import { credentialsFromRequest } from "./credentials.js";
import { errorMessage, ServiceError } from "./errors.js";
import { buildMcpServer } from "./mcp-server.js";
import { externalOrigin, registerOAuthBridge } from "./oauth-bridge.js";
import { TokenManager } from "./token-manager.js";

const config = loadConfig();
const tokens = new TokenManager(config);
const appOptions = config.allowedMcpHosts.length > 0
  ? { host: config.host, allowedHosts: config.allowedMcpHosts }
  : { host: config.host };
const app = express();
const mcpApp = createMcpExpressApp(appOptions);

function matchesSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function authorizeMcp(req: Request, res: Response, next: NextFunction): void {
  if (!config.serverApiKey) {
    next();
    return;
  }
  const authorization = req.header("authorization");
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!matchesSecret(supplied, config.serverApiKey)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized MCP client." },
      id: null,
    });
    return;
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "sap-engagement-cloud-mcp" });
});

app.use(express.urlencoded({ extended: false, limit: "16kb" }));
registerOAuthBridge(app, config);

mcpApp.post("/mcp", authorizeMcp, async (req, res) => {
  let server;
  let transport;
  try {
    const credentials = credentialsFromRequest(req, config);
    server = buildMcpServer(credentials, tokens, config);
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", errorMessage(error));
    if (!res.headersSent) {
      const status = error instanceof ServiceError ? error.statusCode : 500;
      if (status === 401) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${externalOrigin(req)}/.well-known/oauth-protected-resource"`,
        );
      }
      res.status(status).json({
        jsonrpc: "2.0",
        error: {
          code: status === 401 ? -32001 : -32603,
          message: errorMessage(error),
        },
        id: null,
      });
    }
  } finally {
    await transport?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
});

mcpApp.all("/mcp", authorizeMcp, (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed; use POST for this stateless MCP endpoint." },
    id: null,
  });
});

app.use(mcpApp);

const listener = app.listen(config.port, config.host, () => {
  console.log(`SAP Engagement Cloud MCP listening at http://${config.host}:${config.port}/mcp`);
  if (!config.serverApiKey) {
    console.warn("MCP_SERVER_API_KEY is not set; the MCP endpoint has no service-level authentication.");
  }
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}; shutting down.`);
  listener.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
