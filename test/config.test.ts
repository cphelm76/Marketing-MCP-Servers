import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("Cloud Foundry configuration", () => {
  it("uses application routes from VCAP_APPLICATION as allowed MCP hosts", () => {
    const config = loadConfig({
      PORT: "8080",
      HOST: "0.0.0.0",
      EC_TOKEN_URL: "https://tenant.example.com/oauth2/token",
      VCAP_APPLICATION: JSON.stringify({
        application_uris: ["engagement-mcp.example.cfapps.example.com"],
        uris: ["custom.example.com"],
      }),
    });

    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.tokenUrl).toBe("https://tenant.example.com/oauth2/token");
    expect(config.allowedMcpHosts).toEqual([
      "engagement-mcp.example.cfapps.example.com",
      "custom.example.com",
    ]);
  });
});
