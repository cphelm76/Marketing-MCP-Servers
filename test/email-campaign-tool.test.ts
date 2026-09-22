import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { TokenManager } from "../src/token-manager.js";

describe("email campaign MCP tool", () => {
  let apiServer: Server | undefined;

  afterEach(async () => {
    if (apiServer) {
      await new Promise<void>((resolve, reject) =>
        apiServer?.close((error) => error ? reject(error) : resolve()));
      apiServer = undefined;
    }
  });

  function configFor(port: number): AppConfig {
    return {
      host: "127.0.0.1",
      port: 3000,
      defaultBaseUrl: `http://127.0.0.1:${port}/api`,
      allowInsecureUrls: true,
      allowedEcHosts: ["127.0.0.1"],
      allowedMcpHosts: [],
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
    };
  }

  it("uses POST /v3/email and forwards the documented campaign fields", async () => {
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
        res.end(JSON.stringify({ replyCode: 0, replyText: "OK", data: { id: 1234, event_id: 0 } }));
      });
    });
    await new Promise<void>((resolve) => apiServer?.listen(0, "127.0.0.1", resolve));
    const address = apiServer.address();
    if (!address || typeof address === "string") throw new Error("No API test address");

    const config = configFor(address.port);
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
    const client = new Client({ name: "email-campaign-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "engagement_cloud_create_email_campaign",
      arguments: {
        name: "August newsletter",
        language: "en",
        fromemail: "Sender@example.com",
        fromname: "Example Store",
        subject: "August news",
        email_category: "0",
        html_source: "<html><body>Hello</body></html>",
        text_source: "Hello",
        filter: 222,
        administrator: 112233,
        unsubscribe: 1,
        browse: 0,
        keep_raw_html: 1,
        keep_raw_text: 1,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(observedMethod).toBe("POST");
    expect(observedPath).toBe("/api/v3/email");
    expect(observedBody).toEqual({
      name: "August newsletter",
      language: "en",
      fromemail: "Sender@example.com",
      fromname: "Example Store",
      subject: "August news",
      email_category: "0",
      html_source: "<html><body>Hello</body></html>",
      text_source: "Hello",
      filter: "222",
      administrator: 112233,
      unsubscribe: 1,
      browse: 0,
      keep_raw_html: 1,
      keep_raw_text: 1,
    });

    await client.close();
    await mcpServer.close();
  });

  it("rejects a campaign without a documented recipient source", async () => {
    const config = configFor(1);
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
    const client = new Client({ name: "email-campaign-validation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "engagement_cloud_create_email_campaign",
      arguments: {
        name: "No recipients",
        language: "en",
        fromemail: "sender@example.com",
        fromname: "Example Store",
        subject: "No recipients",
        email_category: "0",
        html_source: "<p>Hello</p>",
        text_source: "Hello",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("At least one email recipient source is required"),
      }),
    ]);

    await client.close();
    await mcpServer.close();
  });
});
