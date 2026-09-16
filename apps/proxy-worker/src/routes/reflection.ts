/**
 * Root-level reflection endpoint: this *instance's* live configuration —
 * registry items with their public subdomain URL, upstream target, and header
 * templates (secret references only, never values). Tells a consumer what's
 * configured and how to call each service.
 *
 * Any valid token (`proxy:call` or `admin`) may read it; a token restricted by
 * `integrations` only sees its permitted services.
 * @module
 */
import { createRouter } from "@/utils";
import { getDeps } from "@/deps";
import { isPermitted, requireScopes } from "@/lib/auth";

export const reflectionApp = createRouter()
  .use("/", requireScopes("proxy:call", "admin"))
  .get("/", async (ctx) => {
    const { registry } = await getDeps(ctx);
    const items = await registry.getAll();
    const reqUrl = new URL(ctx.req.url);
    // Canonical public base (HODOR_APP_URL, e.g. https://example.com): service URLs
    // are advertised against this, NOT the inbound host, so reflection from any
    // subdomain still reports https://<id>.<apex> instead of stacking prefixes.
    const canonical = ctx.env.HODOR_APP_URL ? new URL(ctx.env.HODOR_APP_URL) : reqUrl;
    const payload = ctx.var.jwtPayload;

    const services = Object.values(items)
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .filter((item) => isPermitted({ payload, id: item.id }))
      .map((item) => ({
        id: item.id,
        meta: item.meta,
        url: `${canonical.protocol}//${item.id}.${canonical.host}`,
        target: { host: item.url.host, ...(item.url.path ? { path: item.url.path } : {}) },
        headers: item.headers,
        ...(item.query ? { query: item.query } : {}),
        ...(item.identifiers ? { identifiers: item.identifiers } : {}),
      }));

    return ctx.json({
      baseUrl: `${reqUrl.protocol}//${reqUrl.host}`,
      auth: "X-Authorization: Bearer <JWT>",
      services,
    });
  });
