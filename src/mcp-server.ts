import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { EngagementCloudCredentials } from "./credentials.js";
import { EngagementCloudClient } from "./engagement-cloud-client.js";
import { errorMessage, ServiceError } from "./errors.js";
import { FixedAccessTokenProvider, type TokenManager } from "./token-manager.js";

const primitive = z.union([z.string(), z.number(), z.boolean()]);
const queryValue = z.union([primitive, z.array(primitive)]);
const segmentCondition = z.object({
  field: z.string().min(1)
    .describe("Emarsys contact field string ID, for example 'gender' or 'optin'"),
  operator: z.string().min(1)
    .describe("Emarsys contact-filter operator, for example 'equals', 'contains', or 'not_empty'"),
  value: primitive.optional()
    .describe("Comparison value. May be omitted for not_empty and empty operators."),
});

interface ContactSegmentInput {
  name: string;
  description?: string;
  baseContactListId?: string | number;
  country?: string;
  requireEmail?: boolean;
  match?: "and" | "or";
  conditions?: Array<{
    field: string;
    operator: string;
    value?: string | number | boolean;
  }>;
}

interface EmailCampaignInput {
  name: string;
  language: string;
  fromemail: string;
  fromname: string;
  subject: string;
  email_category: string;
  html_source: string;
  text_source: string;
  external_event_id?: string | number;
  filter?: string | number;
  combined_segment_id?: string | number;
  contactlist?: string | number;
  administrator?: number;
  template?: number;
  unsubscribe?: 0 | 1;
  browse?: 0 | 1;
  text_only?: 0 | 1;
  cc_list?: string;
  additional_linktracking_parameters?: string;
  exclude_filter?: number;
  exclude_contact_list_id?: number;
  link_domain_id?: number;
  keep_raw_html?: 0 | 1;
  keep_raw_text?: 0 | 1;
}

export function buildEmailCampaignBody(input: EmailCampaignInput): Record<string, unknown> {
  const stringIdentifierFields = new Set([
    "external_event_id",
    "filter",
    "combined_segment_id",
    "contactlist",
  ]);
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        stringIdentifierFields.has(key) ? String(value) : value,
      ]),
  );
}

export function buildContactSegmentBody(input: ContactSegmentInput): Record<string, unknown> {
  const children: Array<Record<string, unknown>> = [];

  if (input.country) {
    children.push({
      type: "criteria",
      field: "country",
      operator: "equals",
      value: input.country,
    });
  }
  if (input.requireEmail) {
    children.push({
      type: "criteria",
      field: "email",
      operator: "not_empty",
      value: "is_not_empty",
    });
  }
  for (const condition of input.conditions ?? []) {
    const normalizedValue = condition.value ??
      (condition.operator === "not_empty" ? "is_not_empty" : undefined) ??
      (condition.operator === "empty" ? "is_empty" : undefined);
    children.push({
      type: "criteria",
      field: condition.field,
      operator: condition.operator,
      ...(normalizedValue === undefined ? {} : { value: normalizedValue }),
    });
  }

  const body: Record<string, unknown> = {
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    baseContactListId: String(input.baseContactListId ?? 0),
    contactCriteria: {
      type: input.match ?? "and",
      children,
    },
  };
  return body;
}

function successfulResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function failedResult(error: unknown) {
  const details = error instanceof ServiceError ? error.details : undefined;
  const value = { error: errorMessage(error), ...(details === undefined ? {} : { details }) };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function buildMcpServer(
  credentials: EngagementCloudCredentials,
  tokens: TokenManager,
  config: AppConfig,
): McpServer {
  const server = new McpServer({
    name: "sap-engagement-cloud",
    version: "1.0.0",
  });
  const tokenProvider = credentials.accessToken
    ? new FixedAccessTokenProvider(credentials.accessToken)
    : tokens;
  const client = new EngagementCloudClient(credentials, tokenProvider, config);

  server.registerTool(
    "engagement_cloud_test_connection",
    {
      title: "Test SAP Engagement Cloud connection",
      description:
        "Validates the supplied SAP Engagement Cloud OAuth client credentials. The access token is never returned.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return successfulResult(await client.testConnection());
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  server.registerTool(
    "engagement_cloud_get_settings",
    {
      title: "Get SAP Emarsys account settings",
      description:
        "Gets the authenticated account settings from GET /v3/settings. Useful as a full token-and-API connectivity check.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return successfulResult(await client.request({ method: "GET", path: "v3/settings" }));
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  server.registerTool(
    "engagement_cloud_create_contact_segment",
    {
      title: "Create an SAP Engagement Cloud contact segment",
      description:
        "Creates a standard contact segment using the current createSegment operation: PUT /v3/filter. " +
        "For a segment of US contacts with an email address, pass country='United States' and requireEmail=true. " +
        "Never use POST /v3/filter. Report upstream error details exactly instead of inferring a permission problem.",
      inputSchema: {
        name: z.string().min(1).describe("Segment name"),
        description: z.string().optional().describe("Optional segment description"),
        baseContactListId: z.union([z.string(), z.number()]).optional()
          .describe("Optional source contact-list ID; omit to send '0' for all available contacts"),
        country: z.string().min(1).optional()
          .describe("Optional country name; creates a country equals condition"),
        requireEmail: z.boolean().optional().default(false)
          .describe("When true, includes only contacts whose email field is not empty"),
        match: z.enum(["and", "or"]).optional().default("and")
          .describe("How all generated and additional conditions are combined"),
        conditions: z.array(segmentCondition).optional()
          .describe("Optional additional contact-field criteria"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const body = buildContactSegmentBody(input);
        const contactCriteria = body.contactCriteria as { children: unknown[] };
        if (contactCriteria.children.length === 0) {
          throw new ServiceError("At least one segment condition is required.");
        }
        return successfulResult(await client.request({
          method: "PUT",
          path: "v3/filter",
          body,
        }));
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  server.registerTool(
    "engagement_cloud_create_email_campaign",
    {
      title: "Create an SAP Engagement Cloud email campaign",
      description:
        "Creates an email campaign with the documented POST /v3/email operation. " +
        "Supply at least one recipient source: external_event_id, filter, combined_segment_id, or contactlist. " +
        "This creates the campaign only; it does not launch or send it.",
      inputSchema: {
        name: z.string().min(1).describe("Email campaign title"),
        language: z.string().min(1).describe("Email campaign language code, for example 'en'"),
        fromemail: z.string().email().describe("Case-sensitive sender email address"),
        fromname: z.string().min(1).describe("Sender name"),
        subject: z.string().describe("Email subject"),
        email_category: z.string()
          .describe("Email category identifier; use '0' when the campaign has no category"),
        html_source: z.string()
          .describe("HTML email body; not available for template-based campaigns"),
        text_source: z.string()
          .describe("Plain-text email body; not available for template-based campaigns"),
        external_event_id: z.union([z.string().min(1), z.number().int()]).optional()
          .describe("External-event ID to use as the recipient source"),
        filter: z.union([z.string().min(1), z.number().int()]).optional()
          .describe("Segment ID to use as the recipient source"),
        combined_segment_id: z.union([z.string().min(1), z.number().int()]).optional()
          .describe("Combined-segment ID to use as the recipient source"),
        contactlist: z.union([z.string().min(1), z.number().int()]).optional()
          .describe("Contact-list ID to use as the recipient source"),
        administrator: z.number().int().optional()
          .describe("Administrator ID to bind to the campaign instead of the default administrator"),
        template: z.number().int().optional()
          .describe("Template ID for a template-based campaign"),
        unsubscribe: z.union([z.literal(0), z.literal(1)]).optional()
          .describe("Set to 1 to include an unsubscribe link"),
        browse: z.union([z.literal(0), z.literal(1)]).optional()
          .describe("Set to 1 to include an online-version link"),
        text_only: z.union([z.literal(0), z.literal(1)]).optional()
          .describe("Set to 1 for plain-text-only delivery; both content sources must be available"),
        cc_list: z.string().optional()
          .describe("Contact-list ID that receives a copy; requires the BCC List feature"),
        additional_linktracking_parameters: z.string().optional()
          .describe("Additional URL parameters added to tracked-link redirects"),
        exclude_filter: z.number().int().optional()
          .describe("Segment ID to exclude from recipients"),
        exclude_contact_list_id: z.number().int().optional()
          .describe("Contact-list ID to exclude from recipients"),
        link_domain_id: z.number().int().optional()
          .describe("Link-domain ID for the campaign"),
        keep_raw_html: z.union([z.literal(0), z.literal(1)]).optional()
          .describe("Set to 1 to temporarily disable automatic link tracking in HTML content"),
        keep_raw_text: z.union([z.literal(0), z.literal(1)]).optional()
          .describe("Set to 1 to temporarily disable automatic link tracking in plain-text content"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const recipientSources = [
          input.external_event_id,
          input.filter,
          input.combined_segment_id,
          input.contactlist,
        ];
        if (recipientSources.every((value) => value === undefined)) {
          throw new ServiceError(
            "At least one email recipient source is required: external_event_id, filter, combined_segment_id, or contactlist.",
          );
        }
        return successfulResult(await client.request({
          method: "POST",
          path: "v3/email",
          body: buildEmailCampaignBody(input),
        }));
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  server.registerTool(
    "engagement_cloud_request",
    {
      title: "Call the SAP Engagement Cloud API",
      description:
        "Calls an SAP Engagement Cloud / Emarsys REST endpoint relative to the configured API base URL. " +
        "API versions and HTTP methods are endpoint-specific; never infer that an endpoint is v3 from another v3 example. " +
        "For segment creation, always use engagement_cloud_create_contact_segment instead of this generic tool. " +
        "For email campaign creation, always use engagement_cloud_create_email_campaign instead of this generic tool. " +
        "Authentication is added by the service; absolute URLs are rejected.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .describe("HTTP method"),
        path: z.string().min(1)
          .describe("Exact documented relative API path, including its version"),
        query: z.record(queryValue).optional()
          .describe("Optional query string parameters"),
        body: z.unknown().optional()
          .describe("Optional JSON request body"),
      },
      annotations: { openWorldHint: true },
    },
    async ({ method, path, query, body }) => {
      try {
        return successfulResult(await client.request({ method, path, query, body }));
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  return server;
}
