import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { TokenManager } from "../src/token-manager.js";

describe("contact segment MCP tool", () => {
  let apiServer: Server | undefined;

  afterEach(async () => {
    if (apiServer) {
      await new Promise<void>((resolve, reject) =>
        apiServer?.close((error) => error ? reject(error) : resolve()));
      apiServer = undefined;
    }
  });

  it("uses PUT /v3/filter and builds the documented contactCriteria payload", async () => {
    let observedMethod: string | undefined;
    let observedPath: string | undefined;
    let observedBody: unknown;
    apiServer = createServer((req, res) => {
      observedMethod = req.method;
      observedPath = req.url;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        observedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ replyCode: 0, data: { id: 1234 } }));
      });
    });
    await new Promise<void>((resolve) => apiServer?.listen(0, "127.0.0.1", resolve));
    const address = apiServer.address();
    if (!address || typeof address === "string") throw new Error("No API test address");

    const config: AppConfig = {
      host: "127.0.0.1",
      port: 3000,
      defaultBaseUrl: `http://127.0.0.1:${address.port}/api`,
      allowInsecureUrls: true,
      allowedEcHosts: ["127.0.0.1"],
      allowedMcpHosts: [],
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
    };
    const mcpServer = buildMcpServer(
      {
        clientId: "",
        clientSecret: "",
        accessToken: "test-access-token",
        baseUrl: new URL(config.defaultBaseUrl),
      },
      new TokenManager(config),
      config,
    );
    const client = new Client({ name: "segment-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "engagement_cloud_create_contact_segment",
      arguments: {
        name: "Joule Demo",
        country: "United States",
        requireEmail: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(observedMethod).toBe("PUT");
    expect(observedPath).toBe("/api/v3/filter");
    expect(observedBody).toEqual({
      name: "Joule Demo",
      baseContactListId: "0",
      contactCriteria: {
        type: "and",
        children: [
          {
            type: "criteria",
            field: "country",
            operator: "equals",
            value: "United States",
          },
          {
            type: "criteria",
            field: "email",
            operator: "not_empty",
            value: "is_not_empty",
          },
        ],
      },
    });

    await client.close();
    await mcpServer.close();
  });
});
