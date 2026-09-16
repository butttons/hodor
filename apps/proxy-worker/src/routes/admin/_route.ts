/**
 * Admin surface: secrets + registry CRUD, health/info, rekey, and the OpenAPI +
 * docs endpoints. Everything here sits behind the global bearer auth.
 *
 * All params/queries/JSON-bodies are validated with zod via @hono/zod-validator;
 * validation errors render as the flat `{ code, message, status }` envelope.
 * @module
 */
import { Scalar } from "@scalar/hono-api-reference";
import { zValidator } from "@hono/zod-validator";
import { createRouter } from "../../utils";
import { getDeps } from "../../deps";
import { auditAdminCall, defer, requestMeta } from "../../lib/analytics";
import { AppHTTPException, ErrorCodes, validationHook } from "../../lib/errors";
import { getCatalogItem, listCatalog, searchCatalog } from "../../lib/catalog";
import { enrichDomain } from "../../lib/enrich";
import { importEncryptionKey } from "../../lib/secrets";
import { APP_VERSION } from "../../version";
import { requireScopes } from "../../lib/auth";
import { assembleOpenApiDocument } from "../../lib/openapi";
import {
  catalogIdParam,
  enrichQuery,
  keyJtiParam,
  registryIdParam,
  registryItemInput,
  registryReplaceInput,
  rekeyInput,
  secretNameParam,
  secretNamespaceQuery,
} from "../../lib/schema";

/**
 * Scan header template strings for `secret('NAME'[, 'NS'])` references.
 * Returns a Set of `${namespace}:${name}` identities.
 */
function findSecretReferences(headers: Record<string, string>): Set<string> {
  const refs = new Set<string>();
  const re = /secret\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*(?:,\s*['"]([a-z0-9_-]+)['"])?\s*\)/g;
  for (const value of Object.values(headers)) {
    for (const match of value.matchAll(re)) {
      const name = match[1];
      const namespace = match[2] ?? "default";
      refs.add(`${namespace}:${name}`);
    }
  }
  return refs;
}

export const adminApp = createRouter()
  .use("*", requireScopes("admin"))
  // Mutation audit trail → `hodor_audit_log` dataset. Reads excluded.
  .use("*", async (ctx, next) => {
    await next();
    if (ctx.req.method === "GET") return;
    const payload = ctx.var.jwtPayload;
    defer(
      ctx,
      auditAdminCall({
        analytics: ctx.env.HODOR_AUDIT,
        event: {
          keyJti: String(payload?.jti ?? ""),
          keyName: String(payload?.name ?? ""),
          method: ctx.req.method,
          path: new URL(ctx.req.url).pathname,
          status: ctx.res.status,
          ...requestMeta(ctx.req),
        },
      }),
    );
  })
  .get("/secrets", zValidator("query", secretNamespaceQuery, validationHook), async (ctx) => {
    const { secrets } = await getDeps(ctx);
    const namespace = ctx.req.valid("query").namespace;
    const list = await secrets.list(namespace);
    return ctx.json(list.map((secret) => `${secret.namespace}:${secret.name}`));
  })
  .put(
    "/secrets/:name",
    zValidator("param", secretNameParam, validationHook),
    zValidator("query", secretNamespaceQuery, validationHook),
    async (ctx) => {
      const { secrets } = await getDeps(ctx);
      const { name } = ctx.req.valid("param");
      const namespace = ctx.req.valid("query").namespace ?? "default";
      const plaintext = await ctx.req.text();
      if (plaintext.trim().length === 0) {
        throw new AppHTTPException({
          message: "Secret value must not be empty",
          code: ErrorCodes.VALIDATION_FAILED,
          status: 400,
        });
      }
      await secrets.set({ namespace, name, plaintext });
      return ctx.body(null, 204);
    },
  )
  .delete(
    "/secrets/:name",
    zValidator("param", secretNameParam, validationHook),
    zValidator("query", secretNamespaceQuery, validationHook),
    async (ctx) => {
      const { secrets, registry } = await getDeps(ctx);
      const { name } = ctx.req.valid("param");
      const namespace = ctx.req.valid("query").namespace ?? "default";
      const items = await registry.getAll();
      const dependents = Object.values(items)
        .filter((item) => findSecretReferences(item.headers).has(`${namespace}:${name}`))
        .map((item) => item.id);
      if (dependents.length > 0) {
        throw new AppHTTPException({
          message: `Secret is still referenced by registry items: ${dependents.join(", ")}`,
          code: ErrorCodes.CONFLICT,
          status: 409,
        });
      }
      await secrets.delete({ namespace, name });
      return ctx.body(null, 204);
    },
  )
  // Re-key: rotate the master encryption key in-place. The admin passes the
  // OLD key (base64) in the body; the worker decrypts every s:* record with it
  // and re-encrypts under its current HODOR_ENCRYPTION_KEY. Genuinely read-old /
  // write-new in one pass because the old key travels in the request.
  .post("/rekey", zValidator("json", rekeyInput, validationHook), async (ctx) => {
    const { secrets } = await getDeps(ctx);
    const { oldKey } = ctx.req.valid("json");
    let oldCryptoKey: CryptoKey;
    try {
      oldCryptoKey = await importEncryptionKey(oldKey);
    } catch {
      throw new AppHTTPException({
        message: "oldKey is not a valid base64 AES-256 key",
        code: ErrorCodes.VALIDATION_FAILED,
        status: 400,
      });
    }
    const result = await secrets.rekey({ oldCryptoKey });
    return ctx.json(result);
  })
  .get("/registry", async (ctx) => {
    const { registry } = await getDeps(ctx);
    const items = await registry.getAll();
    return ctx.json(items);
  })
  .put("/registry", zValidator("json", registryReplaceInput, validationHook), async (ctx) => {
    const { registry } = await getDeps(ctx);
    await registry.putAll(ctx.req.valid("json"));
    return ctx.body(null, 204);
  })
  .patch(
    "/registry/:id",
    zValidator("param", registryIdParam, validationHook),
    zValidator("json", registryItemInput, validationHook),
    async (ctx) => {
      const { registry } = await getDeps(ctx);
      const { id } = ctx.req.valid("param");
      const item = await registry.putItem({ id, item: ctx.req.valid("json") });
      return ctx.json(item);
    },
  )
  .delete("/registry/:id", zValidator("param", registryIdParam, validationHook), async (ctx) => {
    const { registry } = await getDeps(ctx);
    await registry.deleteItem(ctx.req.valid("param").id);
    return ctx.body(null, 204);
  })
  .get("/catalog/summary", async (ctx) => {
    const rawBase = ctx.env.HODOR_CATALOG_RAW_BASE;
    if (!rawBase) {
      throw new AppHTTPException({
        message: "HODOR_CATALOG_RAW_BASE is not configured",
        code: ErrorCodes.INTERNAL_ERROR,
        status: 500,
      });
    }
    const lookup = await listCatalog(rawBase);
    const items = lookup.items
      .map((item) => ({
        id: item.id,
        meta: {
          label: item.meta.label,
          description: item.meta.description,
          ...(item.meta.docs ? { docs: item.meta.docs } : {}),
          ...(item.meta.openapi ? { openapi: item.meta.openapi } : {}),
          ...(item.meta.llms ? { llms: item.meta.llms } : {}),
          ...(item.meta.icon ? { icon: item.meta.icon } : {}),
          ...(item.meta.note ? { note: item.meta.note } : {}),
        },
      }))
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    return ctx.json({ items, errors: lookup.errors });
  })
  .get("/catalog", async (ctx) => {
    const rawBase = ctx.env.HODOR_CATALOG_RAW_BASE;
    if (!rawBase) {
      throw new AppHTTPException({
        message: "HODOR_CATALOG_RAW_BASE is not configured",
        code: ErrorCodes.INTERNAL_ERROR,
        status: 500,
      });
    }
    const lookup = await searchCatalog({ rawBase, query: ctx.req.query("q") });
    return ctx.json(lookup);
  })
  .get("/catalog/:id", zValidator("param", catalogIdParam, validationHook), async (ctx) => {
    const rawBase = ctx.env.HODOR_CATALOG_RAW_BASE;
    if (!rawBase) {
      throw new AppHTTPException({
        message: "HODOR_CATALOG_RAW_BASE is not configured",
        code: ErrorCodes.INTERNAL_ERROR,
        status: 500,
      });
    }
    const item = await getCatalogItem({ rawBase, id: ctx.req.valid("param").id });
    return ctx.json(item);
  })
  // Enrichment from integrations.sh: turn a registrable domain into a candidate
  // proxyItem (host + mapped JEXL auth + secret placeholder + docs) the caller
  // reviews and PATCHes to their registry. Does the easy 80%, not the decision.
  .get("/enrich", zValidator("query", enrichQuery, validationHook), async (ctx) => {
    return ctx.json(await enrichDomain(ctx.req.valid("query").domain));
  })
  // Key revocation (denylist). Keys are JWTs, so revocation adds to a cached
  // KV denylist; verify then rejects immediately within ~TTL across isolates.
  .get("/keys/revoked", async (ctx) => {
    const { revocations } = await getDeps(ctx);
    return ctx.json({ revoked: await revocations.revoked() });
  })
  // Mint ledger: every key ever minted, newest first, with live revocation/
  // expiry state merged in. Metadata only — never the token.
  .get("/keys", async (ctx) => {
    const { mints, revocations } = await getDeps(ctx);
    const revoked = new Set(await revocations.revoked());
    const now = Math.floor(Date.now() / 1000);
    const keys = (await mints.list()).map((mint) => ({
      ...mint,
      revoked: revoked.has(mint.jti),
      expired: mint.exp < now,
    }));
    return ctx.json({ count: keys.length, keys });
  })
  .delete("/keys/:jti", zValidator("param", keyJtiParam, validationHook), async (ctx) => {
    const { revocations } = await getDeps(ctx);
    await revocations.revoke(ctx.req.valid("param").jti);
    return ctx.body(null, 204);
  })
  .get("/health", async (ctx) => {
    const started = Date.now();
    try {
      await ctx.env.HODOR_KV.get("__health"); // KV round-trip probe
    } catch (cause) {
      return ctx.json(
        { healthy: false, error: `KV unreachable: ${(cause as Error).message}` },
        503,
      );
    }
    try {
      await importEncryptionKey(ctx.env.HODOR_ENCRYPTION_KEY);
    } catch {
      return ctx.json({ healthy: false, error: "HODOR_ENCRYPTION_KEY is invalid" }, 503);
    }
    return ctx.json({ healthy: true, latencyMs: Date.now() - started });
  })
  .get("/info", async (ctx) => {
    const { registry, secrets } = await getDeps(ctx);
    const items = await registry.getAll();
    const secretList = await secrets.list();
    const namespaces = [...new Set(secretList.map((secret) => secret.namespace))];
    return ctx.json({
      version: APP_VERSION, // single source: root package.json (scripts/sync-version.mjs)
      itemCount: Object.keys(items).length,
      namespaces,
    });
  })
  .get("/openapi.json", (ctx) => ctx.json(assembleOpenApiDocument(ctx.env.HODOR_APP_URL)))
  .get(
    "/docs",
    Scalar<{ Bindings: Env }>((ctx) => ({
      content: assembleOpenApiDocument(ctx.env.HODOR_APP_URL),
      pageTitle: "hodor API",
    })),
  );
