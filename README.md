# SAP Engagement Cloud MCP server

A Node.js Streamable HTTP MCP server for the OAuth/OIDC-based SAP Engagement Cloud (SAP Emarsys) API. The caller supplies its Engagement Cloud client ID and secret as HTTP headers. The service exchanges them for an access token, keeps the token only in memory, and adds it to SAP API requests.

## MCP tools

- `engagement_cloud_test_connection` — validates the OAuth credentials without exposing the token.
- `engagement_cloud_get_settings` — calls `GET /v3/settings` as a complete connectivity check.
- `engagement_cloud_request` — calls any relative SAP Engagement Cloud REST API path using `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.
- `engagement_cloud_create_contact_segment` — creates a standard contact segment through the current `PUT /v3/filter` operation, including convenient country and non-empty-email criteria.
- `engagement_cloud_create_email_campaign` — creates an email campaign through the documented `POST /v3/email` operation. It requires campaign content plus at least one external-event, segment, combined-segment, or contact-list recipient source; it does not launch the campaign.

The generic tool supports the full API surface without hard-coding a quickly changing endpoint catalog. SAP permissions assigned to the API credential remain the authorization boundary.

## Run locally

Requirements: Node.js 20 or newer.

```sh
npm install
npm run build
```

Set a service-level API key before binding to a network interface:

```powershell
$env:MCP_SERVER_API_KEY = "generate-a-long-random-value"
npm start
```

The endpoints are:

- MCP: `http://127.0.0.1:3000/mcp`
- Health: `http://127.0.0.1:3000/health`

For development, use `npm run dev`. Copy [.env.example](.env.example) as a reference; this service deliberately does not load `.env` files implicitly.

## Pass Engagement Cloud credentials

Configure your MCP client's Streamable HTTP transport to send these headers on **every** request:

| Header | Required | Meaning |
|---|---:|---|
| `Authorization: Bearer ...` | When `MCP_SERVER_API_KEY` is set | Authenticates the MCP caller to this service |
| `X-EC-Client-Id` | Yes | SAP Engagement Cloud API client ID |
| `X-EC-Client-Secret` | Yes | SAP Engagement Cloud API client secret |
| `X-EC-Base-Url` | No | REST base; defaults to `https://api.emarsys.net/api` |

Alternatively, use HTTP Basic authentication with the Engagement Cloud client ID as the username and the client secret as the password. This is useful for MCP clients such as Joule that offer Basic authentication but do not support arbitrary custom headers.

The OAuth token endpoint defaults to `https://auth.emarsys.net/oauth2/token`. If the OIDC API credential in Emarsys displays a different Token Endpoint, set that exact URL in `EC_TOKEN_URL`. Enterprise-edition tenants may also need their tenant-specific API base URL, such as `https://<tenant>.api.cloud.sap.emarsys.net/...`.

For a direct MCP client connection, use the complete endpoint URL ending in `/mcp`. In Joule Studio destination-based configuration, use the host URL as the destination and configure `/mcp` in Joule's separate Path field.

### Joule Work Desktop

Joule Work Desktop uses OAuth 2.0 authorization-code flow with PKCE for remote MCP connectors. Configure its connector as follows:

- URL: `https://<cloud-foundry-route>/mcp`
- Client ID: the SAP Engagement Cloud / Emarsys client ID
- Client Secret: the corresponding Emarsys client secret

Do not leave Client ID or Client Secret set to Automatic. The service publishes MCP protected-resource and OAuth authorization-server metadata, completes Joule's loopback PKCE flow, and validates the supplied credentials against the fixed Emarsys token endpoint. It returns the resulting Emarsys access token to Joule for authenticated MCP requests and supports OAuth refresh-token exchange so Joule can replace expired Emarsys tokens without recreating the connector. The client secret is not persisted by this service.

The authorization-code handoff is held briefly in application memory. Keep the Cloud Foundry application at one instance unless this transient state is moved to a shared store.

Example using the official TypeScript MCP client:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://127.0.0.1:3000/mcp"),
  {
    requestInit: {
      headers: {
        Authorization: `Bearer ${process.env.MCP_SERVER_API_KEY}`,
        "X-EC-Client-Id": process.env.EC_CLIENT_ID!,
        "X-EC-Client-Secret": process.env.EC_CLIENT_SECRET!,
        // Set this for a tenant-specific enterprise API endpoint:
        // "X-EC-Base-Url": process.env.EC_BASE_URL!,
      },
    },
  },
);

const client = new Client({ name: "example", version: "1.0.0" });
await client.connect(transport);
const result = await client.callTool({
  name: "engagement_cloud_get_settings",
  arguments: {},
});
console.log(result);
await client.close();
```

Do not put secrets in MCP tool arguments, prompts, logs, source control, or URL query strings.

## Configuration

All settings use environment variables:

- `HOST` / `PORT` — listen address, default `127.0.0.1:3000`.
- `MCP_SERVER_API_KEY` — protects the MCP endpoint. Strongly recommended outside local development.
- `EC_CLIENT_ID` / `EC_CLIENT_SECRET` — optional deployment-wide credentials instead of per-request headers.
- `EC_BASE_URL` — optional deployment-wide API base URL override.
- `EC_TOKEN_URL` — optional OAuth token endpoint override; use the exact Token Endpoint displayed for the OIDC API credential.
- `EC_ALLOWED_HOSTS` — comma-separated extra exact hosts or parent domain suffixes for custom SAP endpoints.
- `MCP_ALLOWED_HOSTS` — comma-separated allowed HTTP Host header values, especially when binding to `0.0.0.0`.
- `EC_REQUEST_TIMEOUT_MS` — outbound timeout, default 30 seconds.
- `EC_MAX_RESPONSE_BYTES` — maximum response captured by a tool, default 1,000,000 bytes.
- `ALLOW_INSECURE_EC_URLS` — permits HTTP only for local mocks; never enable in production.

By default outbound hosts are restricted to `emarsys.net`, `cloud.sap`, and `ondemand.com`. Relative API paths are enforced so the generic tool cannot override the configured destination.

## Docker

```sh
docker build -t sap-engagement-cloud-mcp .
docker run --rm -p 3000:3000 \
  -e HOST=0.0.0.0 \
  -e MCP_SERVER_API_KEY=replace-me \
  sap-engagement-cloud-mcp
```

When exposing the container through a domain, also set `MCP_ALLOWED_HOSTS` to that hostname.

## Deploy to Cloud Foundry

The included [manifest.yml](manifest.yml) uses the Cloud Foundry Node.js buildpack, binds the app to `0.0.0.0`, consumes Cloud Foundry's injected `PORT`, and configures `/health` as the HTTP health check. The `postinstall` script compiles TypeScript during staging.

Deploy the application:

```sh
cf push
cf app sap-engagement-cloud-mcp
```

Use the HTTPS route reported by `cf app`, followed by `/mcp`, as the MCP server URL.

Engagement Cloud credentials arrive with each MCP request in the `X-EC-*` headers and should not be added to `manifest.yml`. If you want an additional service-level authentication layer, set `MCP_SERVER_API_KEY`; clients must then also send it as an Authorization bearer token.

If you prefer a single deployment-wide SAP credential, set it separately:

```sh
cf set-env sap-engagement-cloud-mcp EC_CLIENT_ID "your-client-id"
cf set-env sap-engagement-cloud-mcp EC_CLIENT_SECRET "your-client-secret"
cf set-env sap-engagement-cloud-mcp EC_BASE_URL "your-api-base-url"
cf restart sap-engagement-cloud-mcp
```

The app automatically reads its route hostnames from `VCAP_APPLICATION` for Host-header validation. Add `MCP_ALLOWED_HOSTS` only when a route or proxy hostname is not present there. The server is stateless, so it can be scaled normally:

```sh
cf scale sap-engagement-cloud-mcp -i 2
```

Access tokens are cached independently in each instance. No shared database or sticky session is required.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

No live SAP credentials are needed for the automated tests; they use a local OAuth/API mock.
# Marketing-MCP-Servers
