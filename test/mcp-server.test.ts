import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function waitUntilReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP server did not start in time")), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("MCP listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`MCP server exited early with code ${code}`));
    });
  });
}

describe("HTTP MCP server", () => {
  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  it("accepts header credentials and lists its tools", async () => {
    const port = await unusedPort();
    child = spawn(process.execPath, ["dist/src/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        MCP_SERVER_API_KEY: "mcp-test-key",
      },
      stdio: "pipe",
    });
    await waitUntilReady(child);

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      {
        requestInit: {
          headers: {
            authorization: "Bearer mcp-test-key",
            "x-ec-client-id": "client-id",
            "x-ec-client-secret": "client-secret",
          },
        },
      },
    );
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    await client.close();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "engagement_cloud_test_connection",
      "engagement_cloud_get_settings",
      "engagement_cloud_create_contact_segment",
      "engagement_cloud_create_email_campaign",
      "engagement_cloud_request",
    ]);
  }, 30_000);

  it("serves health checks outside MCP Host validation", async () => {
    const port = await unusedPort();
    child = spawn(process.execPath, ["dist/src/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        MCP_ALLOWED_HOSTS: "mcp.example.test",
      },
      stdio: "pipe",
    });
    await waitUntilReady(child);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  }, 30_000);
});
