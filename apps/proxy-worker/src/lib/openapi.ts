/**
 * OpenAPI 3.1 document assembly. Component schemas are derived from the zod
 * schemas (`z.toJSONSchema`) so the runtime types and the documented contract
 * share one source of truth.
 * @module
 */
import { z } from "zod";
import { proxyItem, secretName, templateString } from "./schema";

export const errorSchemaRef = "Error";

/** Flat `{ code, message, status }` error body — matches lib/errors. */
const errorSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description:
        "Machine-readable code: UNAUTHORIZED, NOT_FOUND, VALIDATION_FAILED, CONFLICT, INTERNAL_ERROR.",
    },
    message: { type: "string", description: "Human-readable description." },
    status: { type: "number", description: "HTTP status." },
  },
  required: ["code", "message", "status"],
  additionalProperties: false,
} as const;

const statusTexts: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
};

/** An error response reference for a given status. */
const errorResponse = (status: number, description?: string) => ({
  description: description ?? statusTexts[status] ?? "Error",
  content: {
    "application/json": { schema: { $ref: `#/components/schemas/${errorSchemaRef}` } },
  },
});

const jsonOk = (schema: unknown, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const bearerSecurity = [{ bearerAuth: [] }];

/** `?namespace=` query param (default namespace applies when omitted). */
const namespaceParam = {
  name: "namespace",
  in: "query",
  required: false,
  description: "Secret namespace. Defaults to `default` when omitted.",
  schema: { type: "string", pattern: "^[a-z0-9_-]{1,32}$" },
} as const;

const securityScheme = {
  securitySchemes: {
    bearerAuth: {
      // Sent in a custom header (not `Authorization`) because `Authorization` is
      // reserved for the per-integration auth the proxy injects upstream.
      type: "apiKey",
      in: "header",
      name: "X-Authorization",
      description:
        "JWT key, sent as `Bearer <token>` in the `X-Authorization` header. Minted via POST /_admin/keys (guarded by the body secret = `HODOR_JWT_SECRET`). Tokens carry scopes (`proxy:call` / `admin`), `integrations` grants (`[{id, only?, except?}]`), and global `only` / `except` rules (`{methods?, paths?}`); `except` always wins, per-item rules narrow the globals. Stripped before forwarding upstream.",
    },
  },
};

/** Assemble the full OpenAPI 3.1 document. */
export function assembleOpenApiDocument(appUrl?: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "hodor",
      version: "0.1.0",
      description:
        "Token-injecting HTTP reverse proxy. Configure named registry items (one subdomain each); the worker resolves JEXL header templates (with `secret()`, `base64`, ...) and proxies to the target, injecting auth automatically. Every proxied request also carries verified consumer identity headers (`X-Hodor-Key`, `X-Hodor-Key-Id`, optional `X-Hodor-Ctx`) so upstreams can identify the calling key. Admin surface under `/_admin`, protected by a shared bearer token.",
    },
    servers: appUrl ? [{ url: appUrl }] : undefined,
    paths: {
      "/_/admin/secrets": {
        get: {
          security: bearerSecurity,
          parameters: [namespaceParam],
          summary: "List secret names",
          responses: {
            200: jsonOk(
              {
                type: "array",
                items: { type: "string" },
                example: ["default:OPENAI_API_KEY", "work:GITHUB_TOKEN"],
              },
              "Secret identities, names only.",
            ),
            401: errorResponse(401),
          },
        },
      },
      "/_/admin/secrets/{name}": {
        parameters: [
          {
            name: "name",
            in: "path",
            required: true,
            description: "Secret name (uppercase underscore).",
            schema: z.toJSONSchema(secretName),
          },
          namespaceParam,
        ],
        put: {
          security: bearerSecurity,
          summary: "Create or update a secret",
          description:
            'Request body is the raw plaintext secret value (not JSON-wrapped). Stored encrypted in KV as {"v":1,"n":nonce,"c":ciphertext} with AES-GCM.',
          requestBody: {
            required: true,
            content: {
              "text/plain": { schema: { type: "string" } },
            },
          },
          responses: {
            204: { description: "Created or updated." },
            400: errorResponse(400),
            401: errorResponse(401),
          },
        },
        delete: {
          security: bearerSecurity,
          summary: "Delete a secret",
          description: "Blocked with 409 if any registry item references this secret.",
          responses: {
            204: { description: "Deleted." },
            401: errorResponse(401),
            409: errorResponse(409, "Secret is still referenced"),
          },
        },
      },
      "/_/admin/registry": {
        get: {
          security: bearerSecurity,
          summary: "Get the full registry",
          responses: {
            200: jsonOk(
              { type: "object", additionalProperties: { $ref: "#/components/schemas/ProxyItem" } },
              "The full registry, keyed by item id.",
            ),
            401: errorResponse(401),
          },
        },
        put: {
          security: bearerSecurity,
          summary: "Replace the entire registry",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: { $ref: "#/components/schemas/ProxyItem" },
                },
              },
            },
          },
          responses: {
            204: { description: "Registry replaced." },
            400: errorResponse(400),
            401: errorResponse(401),
          },
        },
      },
      "/_/admin/registry/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Registry item id (the subdomain label).",
            schema: z.toJSONSchema(proxyItem.shape.id),
          },
        ],
        patch: {
          security: bearerSecurity,
          summary: "Create or update one registry item",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ProxyItem" } },
            },
          },
          responses: {
            200: jsonOk({ $ref: "#/components/schemas/ProxyItem" }, "The saved item."),
            400: errorResponse(400),
            401: errorResponse(401),
          },
        },
        delete: {
          security: bearerSecurity,
          summary: "Delete one registry item",
          responses: {
            204: { description: "Deleted." },
            401: errorResponse(401),
          },
        },
      },
      "/_/admin/catalog/summary": {
        get: {
          security: bearerSecurity,
          summary: "Overview of available catalog integrations",
          description:
            "Lightweight list of every catalog integration (ids + descriptions, sorted by id) for browsing what's available, without pulling full shapes.",
          responses: {
            200: jsonOk(
              {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        label: { type: "string" },
                        description: { type: "string" },
                        docs: { type: "string" },
                        llms: { type: "string" },
                      },
                    },
                  },
                  errors: { type: "object", additionalProperties: { type: "string" } },
                },
              },
              "Catalog overview.",
            ),
            401: errorResponse(401),
            502: errorResponse(502, "Catalog unreachable"),
          },
        },
      },
      "/_/admin/catalog": {
        get: {
          security: bearerSecurity,
          summary: "Search the built-in integration catalog",
          description:
            "Live lookup against the public repository (env HODOR_CATALOG_RAW_BASE). Returns the canonical proxyItem shapes, which you can use as-is or edit, then create/update on your instance via PATCH /_admin/registry/{id}.",
          parameters: [
            {
              name: "q",
              in: "query",
              required: false,
              description: "Filter by id or description (case-insensitive substring).",
              schema: { type: "string" },
            },
          ],
          responses: {
            200: jsonOk(
              {
                type: "object",
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/ProxyItem" } },
                  errors: { type: "object", additionalProperties: { type: "string" } },
                },
              },
              "Matching integrations (shapes ready to PATCH).",
            ),
            401: errorResponse(401),
            502: errorResponse(502, "Catalog unreachable"),
          },
        },
      },
      "/_/admin/catalog/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Catalog integration id.",
            schema: { type: "string" },
          },
        ],
        get: {
          security: bearerSecurity,
          summary: "Fetch one catalog integration",
          responses: {
            200: jsonOk({ $ref: "#/components/schemas/ProxyItem" }, "The integration shape."),
            401: errorResponse(401),
            404: errorResponse(404, "No such catalog item"),
            502: errorResponse(502, "Catalog unreachable"),
          },
        },
      },
      "/_/admin/enrich": {
        get: {
          security: bearerSecurity,
          summary: "Enrich a domain into a candidate catalog item",
          description:
            "Looks up a registrable domain on integrations.sh and returns a candidate proxyItem shape (host + mapped JEXL auth + secret('NAME') placeholder + docs URL). Review/edit it, then PATCH it to your registry.",
          parameters: [
            {
              name: "domain",
              in: "query",
              required: true,
              description: "Registrable domain, e.g. `stripe.com`.",
              schema: { type: "string" },
            },
          ],
          responses: {
            200: jsonOk({}, "A candidate proxyItem-ish shape with auth + credentials."),
            401: errorResponse(401),
            404: errorResponse(404, "Domain not found on integrations.sh"),
            502: errorResponse(502, "integrations.sh unreachable"),
          },
        },
      },
      "/_/admin/keys": {
        post: {
          summary: "Mint an API key",
          description:
            "The one unauthenticated path (feedr pattern). Creates a JWT key; the body `secret` must equal the `HODOR_JWT_SECRET` env value. Scopes: `proxy:call` (may use the proxy) and/or `admin` (may use /_admin). Key `name`s are unique among live keys — re-minting a live name returns `409` (revoke first). Optional `integrations` grants (`[{id, only?, except?}]`) restrict which registry items a key can call and how; global `only` / `except` (`{methods?, paths?}`) apply to every listed item. Path entries are Hono-style (`/v1/models`) or `METHOD /path` strings (`GET /v1/models`). `except` always wins; per-item rules narrow the globals. `ctx` is an optional consumer context forwarded upstream as `X-Hodor-Ctx`.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    secret: { type: "string" },
                    name: { type: "string" },
                    scopes: {
                      type: "array",
                      items: { type: "string", enum: ["proxy:call", "admin"] },
                    },
                    integrations: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          only: { type: "object" },
                          except: { type: "object" },
                        },
                        required: ["id"],
                      },
                    },
                    only: { type: "object" },
                    except: { type: "object" },
                    expiresInSeconds: { type: "number" },
                    ctx: {
                      description:
                        "Optional consumer context forwarded verbatim to upstreams as `X-Hodor-Ctx` (strings pass as-is, JSON values are stringified).",
                      oneOf: [
                        { type: "string" },
                        { type: "object" },
                        { type: "array", items: {} },
                        { type: "number" },
                        { type: "boolean" },
                      ],
                    },
                  },
                  required: ["secret", "name", "scopes"],
                },
              },
            },
          },
          responses: {
            201: jsonOk(
              {
                type: "object",
                properties: {
                  token: { type: "string" },
                  jti: { type: "string" },
                  name: { type: "string" },
                  scopes: { type: "array", items: { type: "string" } },
                  exp: { type: "number" },
                },
              },
              "The minted key.",
            ),
            400: errorResponse(400),
            401: errorResponse(401, "Invalid secret"),
          },
        },
        get: {
          security: bearerSecurity,
          summary: "List minted keys",
          description:
            "Admin-only. Every key ever minted (metadata only — never the token), newest first, with live `revoked` / `expired` flags merged in.",
          responses: {
            200: jsonOk(
              { type: "object", properties: { count: { type: "number" } } },
              "The mint ledger.",
            ),
            401: errorResponse(401),
            403: errorResponse(403, "Requires admin scope"),
          },
        },
      },
      "/_/admin/health": {
        get: {
          security: bearerSecurity,
          summary: "Liveness check",
          responses: {
            200: jsonOk({ type: "object", properties: { healthy: { type: "boolean" } } }, "OK"),
          },
        },
      },
      "/_/admin/info": {
        get: {
          security: bearerSecurity,
          summary: "Non-sensitive runtime summary",
          responses: {
            200: jsonOk(
              {
                type: "object",
                properties: {
                  itemCount: { type: "number" },
                  namespaces: { type: "array", items: { type: "string" } },
                },
              },
              "Summary.",
            ),
          },
        },
      },
    },
    components: {
      ...securityScheme,
      schemas: {
        [errorSchemaRef]: errorSchema,
        TemplateString: z.toJSONSchema(templateString),
        ProxyItem: z.toJSONSchema(proxyItem),
      },
    },
  };
}
