/**
 * Registry item + secret schemas — the single source of truth for everything
 * stored in KV and validated on admin writes.
 * Schemas are camelCase; only the inferred types are PascalCase (locked rule).
 * @module
 */
import { z } from "zod";
import jexl from "jexl";

/**
 * A JEXL header-expression string. Validated for *grammar* at parse time via
 * `jexl.compile()` (a strictness beyond flaggly); semantic checks (unknown
 * secrets/functions, NaN results) happen at resolve time in the engine.
 */
export const templateString = z.string().superRefine((value, ctx) => {
  if (value.trim().length === 0) return;
  try {
    jexl.compile(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JEXL expression",
    });
  }
});

/** A registry item: one subdomain → one upstream target. */
/** Human-friendly metadata about an integration. */
const itemMeta = z.object({
  label: z.string().min(1, "meta.label is required"),
  description: z.string().min(1, "meta.description is required"),
  docs: z.string().url("docs must be a valid URL").optional(),
  // Machine-readable OpenAPI spec URL, if the integration publishes one.
  openapi: z.string().url("openapi must be a valid URL").optional(),
  // Agent-friendly llms.txt doc URL, if the integration publishes one.
  llms: z.string().url("llms must be a valid URL").optional(),
  // Icon: a URL to an image (not an emoji).
  icon: z.string().url("icon must be a URL").optional(),
  // Free-form note surfaced in catalog/reflection (e.g. auth caveats).
  note: z.string().max(500, "note must be 500 chars or fewer").optional(),
});

/** A canonical endpoint to verify a catalog item actually reaches its upstream. */
const probe = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  path: z.string().startsWith("/", "probe.path must start with /"),
});

export const proxyItem = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "id must be a subdomain-safe label"),
  url: z.object({
    protocol: z.enum(["http", "https"]).default("https"),
    host: z.string().min(1, "host is required"),
    path: z.string().startsWith("/", "path must start with /").optional(),
  }),
  /**
   * Static header values, injected upstream. Values are JEXL expressions, so
   * auth is expressed as `'Bearer ' + secret('OPENAI_API_KEY')`. Client headers
   * pass through; these override on conflict.
   */
  headers: z.record(z.string(), templateString),
  /**
   * Query params injected upstream (e.g. Gemini `?key=`, OpenWeather `?appid=`)
   * for services that authenticate via a query string rather than a header.
   * Values are JEXL expressions, resolved like headers, and merged onto the
   * upstream URL (overriding any client-sent value).
   */
  query: z.record(z.string(), templateString).optional(),
  /**
   * Informational description of `[token]` placeholders that may appear in
   * `url.host`/`url.path` (e.g. Shopify `[store]`, Algolia `[app]`). The proxy
   * does no substitution — a user replaces each token with their real value
   * when they register the item. This map only documents, for each variable,
   * what value to put there. Not secrets.
   */
  variables: z.record(z.string(), z.string().min(1)).optional(),
  /**
   * Non-secret identifiers/attributes a caller needs to use this integration
   * on this instance (e.g. project IDs, zone IDs, dataset names, region).
   * Surfaced verbatim in reflection. Never put secret values here.
   */
  identifiers: z
    .record(z.string(), z.union([z.string().min(1), z.array(z.string().min(1))]))
    .optional(),
  meta: itemMeta,
  probe: probe.optional(),
});

export type ProxyItem = z.infer<typeof proxyItem>;

/** A full keyed registry, mirroring the shape you locked. */
export const registry = z.object({
  items: z.record(proxyItem.shape.id, proxyItem),
});

export type Registry = z.infer<typeof registry>;

/** An uppercase secret name, e.g. `OPENAI_API_KEY`. */
export const secretName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "secret name must be uppercase underscore");

/** A lowercase namespace label, e.g. `default` or `work`. */
export const namespaceName = z.string().regex(/^[a-z0-9_-]{1,32}$/, "namespace must be lowercase");

// --- Request validation (used with @hono/zod-validator) ---

/** `{ name }` path param for `/_admin/secrets/:name`. */
export const secretNameParam = z.object({ name: secretName });

/** Optional `?namespace=` query for secret routes. */
export const secretNamespaceQuery = z.object({ namespace: namespaceName.optional() });

/** `{ id }` path param for `/_admin/registry/:id`. */
export const registryIdParam = z.object({ id: proxyItem.shape.id });

/** `{ id }` path param for `/_admin/catalog/:id`. */
export const catalogIdParam = z.object({ id: z.string().min(1) });

/** `{ domain }` query for `/_admin/enrich`. */
export const enrichQuery = z.object({ domain: z.string().min(1, "domain is required") });

/** `{ jti }` path param for `/_admin/keys/:jti`. */
export const keyJtiParam = z.object({ jti: z.string().min(1) });

/** Body for `POST /_admin/rekey`: the previous master key (base64). */
export const rekeyInput = z.object({ oldKey: z.string().min(1, "oldKey is required") });

/**
 * Body for `PATCH /_admin/registry/:id` — a proxyItem whose `id` may be
 * omitted (it's taken from the path).
 */
export const registryItemInput = z.object({
  id: proxyItem.shape.id.optional(),
  url: proxyItem.shape.url,
  headers: proxyItem.shape.headers,
  query: proxyItem.shape.query,
  variables: proxyItem.shape.variables,
  identifiers: proxyItem.shape.identifiers,
  meta: proxyItem.shape.meta,
  probe: proxyItem.shape.probe,
});

/** Body for `PUT /_admin/registry` — a map of id → item. */
export const registryReplaceInput = z.record(z.string().min(1), z.record(z.string(), z.unknown()));
