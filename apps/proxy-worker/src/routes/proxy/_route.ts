/**
 * Reverse-proxy handler. The first label of the request host is the registry
 * item id (`openai.example.com` → item `openai`); header templates are resolved
 * (injecting auth) and the request is forwarded to the item target.
 *
 * Access is RBAC-guarded: the token needs the `proxy:call` scope, must be
 * permitted for the item (via the `integrations` claim), and must satisfy the
 * token's path allow/block rules.
 *
 * Every proxied request carries verified consumer identity headers
 * (`X-Hodor-Key` / `X-Hodor-Key-Id` / optional `X-Hodor-Ctx`) —
 * stripped-then-stamped, so the upstream sees who called and cannot be tricked.
 *
 * Audit logging is always done: every terminal outcome records a data point —
 * 401 (no/invalid token), 403 (scope/item/path/method denied), 404 (unknown
 * integration label), 0 (upstream fetch error), or the upstream status.
 * @module
 */
import { createRouter } from "../../utils";
import { getDeps } from "../../deps";
import { AppHTTPException, ErrorCodes } from "../../lib/errors";
import { hasScope, isGloballyAllowed, isItemAllowed, isPermitted } from "../../lib/auth";
import { consumerIdentityHeaders, IDENTITY_HEADERS } from "../../lib/identity";
import { buildUpstreamUrl, mergeQuery } from "../../lib/target";
import { auditProxyCall, requestMeta } from "../../lib/analytics";

const NO_BODY = new Set(["GET", "HEAD"]);

/** Hop-by-hop + routing headers we must not forward upstream. */
const STRIPPED = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "expect",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
  // Inbound caller auth — never forwarded upstream. `authorization` is also
  // stripped: for LLM items the proxy overrides it with the injected secret
  // anyway, and for others the caller's JWT must not leak.
  "authorization",
  "x-authorization",
  // Consumer identity — stamped from the verified JWT below, so any
  // client-sent copy is dropped rather than forwarded or forged.
  ...IDENTITY_HEADERS,
]);

/**
 * Client headers pass through, then the item's resolved (auth) headers
 * override on conflict.
 */
function buildForwardHeaders(input: {
  incoming: Headers;
  resolved: Record<string, string>;
}): Headers {
  const { incoming, resolved } = input;
  const headers = new Headers();
  incoming.forEach((value, key) => {
    if (!STRIPPED.has(key.toLowerCase())) headers.set(key, value);
  });
  for (const [name, value] of Object.entries(resolved)) headers.set(name, value);
  return headers;
}

export const proxyApp = createRouter().all("*", async (ctx) => {
  const host = ctx.req.header("host") ?? "";
  const label = host.split(".")[0].toLowerCase();
  const pathname = new URL(ctx.req.url).pathname;
  const method = ctx.req.method;
  const startedAt = Date.now();

  // One audit data point per request, recorded on every exit path (deferred so
  // it never delays the response). itemId is the registry id; for rejections
  // before the item resolves we fall back to the host label.
  const record = (input: { itemId: string; keyJti?: unknown; keyName?: unknown; status: number }) =>
    ctx.executionCtx.waitUntil(
      auditProxyCall({
        analytics: ctx.env.HODOR_ANALYTICS,
        event: {
          itemId: input.itemId,
          keyJti: String(input.keyJti ?? ""),
          keyName: String(input.keyName ?? ""),
          method,
          path: pathname,
          status: input.status,
          durationMs: Date.now() - startedAt,
          ...requestMeta(ctx.req),
        },
      }),
    );

  const payload = ctx.var.jwtPayload;
  if (!payload) {
    record({ itemId: label, status: 401 });
    throw new AppHTTPException({
      code: ErrorCodes.UNAUTHORIZED,
      message: "Missing or invalid token",
      status: 401,
    });
  }
  if (!hasScope({ payload, scope: "proxy:call" })) {
    record({ itemId: label, keyJti: payload.jti, keyName: payload.name, status: 403 });
    throw new AppHTTPException({
      code: ErrorCodes.UNAUTHORIZED,
      message: "Missing required scope: proxy:call",
      status: 403,
    });
  }

  const { registry, engine } = await getDeps(ctx);
  let item;
  try {
    item = await registry.getOne(label); // throws NOT_FOUND for unknown labels
  } catch (err) {
    record({ itemId: label, keyJti: payload.jti, keyName: payload.name, status: 404 });
    throw err;
  }

  if (!isPermitted({ payload, id: item.id })) {
    record({ itemId: item.id, keyJti: payload.jti, keyName: payload.name, status: 403 });
    throw new AppHTTPException({
      message: `Token is not permitted for integration "${item.id}"`,
      code: ErrorCodes.UNAUTHORIZED,
      status: 403,
    });
  }
  if (!isItemAllowed({ payload, id: item.id, pathname, method })) {
    record({ itemId: item.id, keyJti: payload.jti, keyName: payload.name, status: 403 });
    throw new AppHTTPException({
      message: `Token is not permitted for "${method} ${pathname}" on integration "${item.id}"`,
      code: ErrorCodes.UNAUTHORIZED,
      status: 403,
    });
  }
  if (!isGloballyAllowed({ payload, pathname, method })) {
    record({ itemId: item.id, keyJti: payload.jti, keyName: payload.name, status: 403 });
    throw new AppHTTPException({
      message: `Token is not permitted for "${method} ${pathname}"`,
      code: ErrorCodes.UNAUTHORIZED,
      status: 403,
    });
  }

  const upstreamUrl = buildUpstreamUrl({ reqUrl: new URL(ctx.req.url), item });
  // Item auth headers first; verified consumer identity overrides on conflict
  // (and can never be forged — forged copies were stripped above).
  const resolved = {
    ...(await engine().resolveHeaders(item.headers)),
    ...consumerIdentityHeaders(payload),
  };
  await mergeQuery({ upstream: upstreamUrl, item, engine: engine() });
  const headers = buildForwardHeaders({ incoming: ctx.req.raw.headers, resolved });

  const init: RequestInit = {
    method,
    headers,
    redirect: "follow",
  };
  // Buffer the request body so `fetch` sends a real Content-Length (no chunked
  // transfer-encoding) — strict upstreams reject chunked requests. Downside:
  // large uploads are buffered in memory rather than streamed.
  if (!NO_BODY.has(method)) init.body = await ctx.req.arrayBuffer();

  try {
    // Follow redirects so the injected auth header is reapplied on each hop
    // (deliberate: redirect: manual would send the client off-proxy, losing the
    // injected credential).
    const upstream = await fetch(upstreamUrl, init);
    record({
      itemId: item.id,
      keyJti: payload.jti,
      keyName: payload.name,
      status: upstream.status,
    });
    return upstream;
  } catch (err) {
    // Upstream unreachable / refused / timed out — status 0 (never a real HTTP
    // status) so the audit row is clearly an error, not a real response.
    record({ itemId: item.id, keyJti: payload.jti, keyName: payload.name, status: 0 });
    throw err;
  }
});
