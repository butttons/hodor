/**
 * JWT + RBAC auth (the feedr pattern).
 *
 * Tokens are JWTs signed with `env.HODOR_JWT_SECRET` (HS256), carried: jti, name,
 * scopes (["proxy:call" | "admin"]), integrations? (array of {id, only?, except?}
 * grants), only?/except? (global {methods?, paths?} rules), ctx? (optional
 * consumer context forwarded upstream as `X-Hodor-Ctx`), iat, exp.
 *
 * One model: everything permitted except what's excluded, narrowed by `only`;
 * `except` always wins; per-item rules intersect the globals (narrow-only).
 *
 * The token is sent as `Bearer <jwt>` in the **`X-Authorization`** header (not
 * `Authorization`, which is reserved for the per-integration auth the proxy
 * injects upstream). `authMiddleware` reads it; the proxy also strips it before
 * forwarding so the caller's JWT never reaches the upstream.
 *
 * Keys are minted at POST /_admin/keys (guarded by knowledge of HODOR_JWT_SECRET), so
 * the first admin key is created before any other token exists.
 *
 * Scopes:
 *   proxy:call  — may route through the reverse proxy (optionally restricted by
 *                 `integrations` grants and `only`/`except` rules).
 *   admin       — may use the `/_admin` surface.
 * @module
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { verify } from "hono/jwt";
import { splitPath, splitRoutingPath } from "hono/utils/url";
import { getRevocationStore } from "./revocation";
import { runtimeOf, type Runtime } from "./runtime";
import { AppHTTPException, ErrorCodes } from "./errors";

export type Scope = "proxy:call" | "admin";

export interface AuthVariables {
  jwtPayload?: Record<string, unknown>;
  runtime?: Runtime;
}

/** The app context: Cloudflare bindings + authenticated JWT payload. */
export type AppEnv = { Bindings: Env; Variables: AuthVariables };

export const hasScope = (input: {
  payload: Record<string, unknown> | undefined;
  scope: Scope;
}): boolean =>
  Array.isArray(input.payload?.["scopes"]) &&
  (input.payload["scopes"] as Scope[]).includes(input.scope);

/** Per-item access rule: optional permit-list (`only`) and deny-list (`except`). */
export interface AccessRule {
  methods?: string[];
  paths?: string[];
}

/** One integration grant: item id plus optional per-item rules. */
export interface IntegrationGrant {
  id: string;
  only?: AccessRule;
  except?: AccessRule;
}

/** The grant for an item id, or undefined when the token doesn't list it. */
export const integrationGrant = (input: {
  payload: Record<string, unknown> | undefined;
  id: string;
}): IntegrationGrant | undefined => {
  const list = input.payload?.["integrations"];
  if (!Array.isArray(list)) return undefined;
  return (list as IntegrationGrant[]).find((g) => g?.id === input.id);
};

/**
 * Whether a token may proxy to a specific item id. Absent `integrations`
 * means unrestricted; present means the id must be listed.
 */
export const isPermitted = (input: {
  payload: Record<string, unknown> | undefined;
  id: string;
}): boolean => {
  const list = input.payload?.["integrations"];
  if (list === undefined) return true;
  if (!Array.isArray(list)) return false;
  return (list as IntegrationGrant[]).some((g) => g?.id === input.id);
};

/** HTTP methods allowed as a `METHOD /path` pattern prefix. */
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Split an optional `METHOD /path` prefix from a pattern. */
function splitMethodPrefix(pattern: string): {
  method: string | null;
  path: string;
} {
  const space = pattern.indexOf(" ");
  if (space > 0) {
    const method = pattern.slice(0, space).toUpperCase();
    if (HTTP_METHODS.has(method)) {
      return { method, path: pattern.slice(space + 1).trim() };
    }
  }
  return { method: null, path: pattern };
}

/**
 * Hono-style path matching: static segments, `:param`, `:param{regex}`, and
 * a trailing `*` wildcard. Uses hono's own `splitRoutingPath`/`splitPath`.
 * A plain pattern (`/v1/models`) matches by path; a `METHOD /path` pattern
 * (`GET /v1/models`) additionally requires an exact method match.
 */
function matchPattern(input: { pattern: string; pathname: string; method?: string }): boolean {
  const { pattern, pathname } = input;
  const { method, path } = splitMethodPrefix(pattern);
  if (method && input.method?.toUpperCase() !== method) return false;

  const labels = splitRoutingPath(path);
  const segments = splitPath(pathname);
  let segIndex = 0;
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index];
    if (label === "*") return true; // wildcard matches remaining segments
    if (segIndex >= segments.length) return false;
    const param = label.match(/^:([^{}]+?)(?:\{(.*)\})?$/);
    let ok: boolean;
    if (param) ok = param[2] ? new RegExp(`^${param[2]}$`).test(segments[segIndex]) : true;
    else ok = label === segments[segIndex];
    if (!ok) return false;
    segIndex++;
  }
  return segIndex === segments.length;
}

/**
 * Evaluate one `{only?, except?}` rule set against a method+path.
 * `except` match denies; present `only` axes must each match
 * (present-but-empty allows nothing); absent axes are unrestricted.
 * Method names are compared uppercase and case-insensitively. Path entries
 * may be plain paths (`/v1/models`) or `METHOD /path` strings
 * (`GET /v1/models`).
 */
export const isRuleAllowed = (input: {
  only?: AccessRule;
  except?: AccessRule;
  pathname: string;
  method?: string;
}): boolean => {
  const { only, except, pathname, method } = input;
  const norm = method?.toUpperCase();
  if (except) {
    if (except.methods?.some((m) => String(m).toUpperCase() === norm)) return false;
    if (except.paths?.some((pat) => matchPattern({ pattern: pat, pathname, method }))) return false;
  }
  if (only) {
    if (only.methods !== undefined && !only.methods.some((m) => String(m).toUpperCase() === norm))
      return false;
    if (
      only.paths !== undefined &&
      !only.paths.some((pat) => matchPattern({ pattern: pat, pathname, method }))
    )
      return false;
  }
  return true;
};

/** Per-item rules for an integration grant (narrow-only; membership is `isPermitted`). */
export const isItemAllowed = (input: {
  payload: Record<string, unknown> | undefined;
  id: string;
  pathname: string;
  method?: string;
}): boolean => {
  const grant = integrationGrant({ payload: input.payload, id: input.id });
  if (!grant) return true;
  return isRuleAllowed({
    only: grant.only,
    except: grant.except,
    pathname: input.pathname,
    method: input.method,
  });
};

/** Global `only`/`except` rules. */
export const isGloballyAllowed = (input: {
  payload: Record<string, unknown> | undefined;
  pathname: string;
  method?: string;
}): boolean =>
  isRuleAllowed({
    only: input.payload?.["only"] as AccessRule | undefined,
    except: input.payload?.["except"] as AccessRule | undefined,
    pathname: input.pathname,
    method: input.method,
  });

/** Verify a bearer header into a JWT payload, or undefined if absent/invalid. */
async function resolvePayload(input: {
  header: string | undefined;
  jwtSecret: string | undefined;
  isRevoked: (jti: string) => Promise<boolean>;
}): Promise<Record<string, unknown> | undefined> {
  const { header, jwtSecret, isRevoked } = input;
  if (!header?.startsWith("Bearer ")) return undefined;
  if (!jwtSecret) return undefined;
  const token = header.slice(7).trim();
  if (!token) return undefined;
  try {
    const payload = await verify(token, jwtSecret, "HS256");
    // A valid-but-revoked key is treated as absent (guards then 401/403).
    if (typeof payload.jti === "string" && (await isRevoked(payload.jti))) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

/**
 * Pick the inbound bearer header: prefer `X-Authorization`, fall back to
 * `Authorization`. The fallback lets stock OpenAI-compatible clients (which only
 * send `Authorization`) authenticate without config — for LLM items the proxy
 * overrides `Authorization` upstream anyway, so the caller's value never leaks.
 */
function bearerHeader(ctx: Context<AppEnv>): string | undefined {
  return ctx.req.header("X-Authorization") ?? ctx.req.header("Authorization");
}

/** Verify + attach a payload for every request. Does not reject; guards do. */
export const authMiddleware = createMiddleware<AppEnv>(async (ctx, next) => {
  // One runtime object per request (storage is cached per binding; standalone
  // storage is a process-wide singleton). The revocation check runs from a
  // per-isolate in-memory cache, so the hot path is a Set.has() with no store hit.
  const runtime = await runtimeOf(ctx);
  ctx.set("runtime", runtime);
  const revocations = getRevocationStore(runtime.storage);
  ctx.set(
    "jwtPayload",
    await resolvePayload({
      header: bearerHeader(ctx),
      jwtSecret: runtime.env("HODOR_JWT_SECRET"),
      isRevoked: (jti) => revocations.isRevoked(jti),
    }),
  );
  await next();
});

/** Require a valid token carrying at least one of the given scopes. */
export const requireScopes = (...scopes: Scope[]) =>
  createMiddleware<AppEnv>(async (ctx, next) => {
    const payload = ctx.var.jwtPayload;
    if (!payload) {
      throw new AppHTTPException({
        code: ErrorCodes.UNAUTHORIZED,
        message: "Missing or invalid token",
        status: 401,
      });
    }
    if (!scopes.some((scope) => hasScope({ payload, scope }))) {
      throw new AppHTTPException({
        code: ErrorCodes.UNAUTHORIZED,
        message: `Missing required scope: ${scopes.join(" or ")}`,
        status: 403,
      });
    }
    await next();
  });
