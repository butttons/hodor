import { describe, it, expect } from "vitest";
import { sign, verify } from "hono/jwt";
import { Hono } from "hono";
import {
  authMiddleware,
  isGloballyAllowed,
  isItemAllowed,
  isPermitted,
  isRuleAllowed,
  requireScopes,
  type AppEnv,
  type Scope,
} from "../auth";

/** Test-only HMAC secret (must match nothing in production). */
const TEST_SECRET = "test-secret-for-auth-spec-only-0123456789";

/** Wire the same error envelope the worker uses, so AppHTTPException maps to its status. */
function withErrorHandling(app: Hono<AppEnv>): Hono<AppEnv> {
  return app.onError((error, c) => {
    const e = error as { status?: number; toJSON?: () => unknown };
    if (typeof e.status === "number" && typeof e.toJSON === "function") {
      return c.json(e.toJSON(), e.status as never);
    }
    return c.json({ code: "INTERNAL_ERROR", message: (error as Error).message, status: 500 }, 500);
  });
}

/** Sign a JWT the way POST /_admin/keys does. */
async function mint(payload: Record<string, unknown>): Promise<string> {
  return sign({ iat: 0, exp: 9999999999, ...payload }, TEST_SECRET);
}

/** A minimal guarded app so the real middleware chain (verify → guard) is exercised. */
function guardedApp(...scopes: Scope[]) {
  const app = new Hono<AppEnv>()
    .use("*", authMiddleware)
    .use("*", requireScopes(...scopes))
    .get("/probe", (c) => c.json({ ok: true, scopes: c.var.jwtPayload?.["scopes"] }));
  return withErrorHandling(app);
}

const env = { HODOR_JWT_SECRET: TEST_SECRET } as unknown as Env;

/** JWT signing/verification round-trip (the mint→use loop). */
describe("JWT round-trip", () => {
  it("signs and verifies claims", async () => {
    const token = await mint({
      jti: "k-1",
      name: "ci",
      scopes: ["proxy:call"],
      integrations: ["stripe"],
    });
    const payload = await verify(token, TEST_SECRET, "HS256");
    expect(payload.scopes).toEqual(["proxy:call"]);
    expect(payload.integrations).toEqual(["stripe"]);
  });

  it("verification fails with the wrong secret", async () => {
    const token = await mint({ scopes: ["admin"] });
    await expect(verify(token, "wrong-secret", "HS256")).rejects.toThrow();
  });

  it("an expired token fails", async () => {
    const token = await sign(
      { scopes: ["admin"], iat: 0, exp: Math.floor(Date.now() / 1000) - 10 },
      TEST_SECRET,
    );
    await expect(verify(token, TEST_SECRET, "HS256")).rejects.toThrow();
  });
});

/** requireScopes middleware enforcement. */
describe("requireScopes()", () => {
  it("401 without a token", async () => {
    const res = await guardedApp("proxy:call").request("/probe", {}, env);
    expect(res.status).toBe(401);
  });

  it("401 when a valid token's jti is revoked", async () => {
    const token = await mint({ jti: "revoked-1", scopes: ["admin"] });
    const kv = {
      get: async () => JSON.stringify(["revoked-1"]),
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace;
    const res = await guardedApp("admin").request(
      "/probe",
      { headers: { "X-Authorization": `Bearer ${token}` } },
      { ...env, HODOR_KV: kv },
    );
    expect(res.status).toBe(401);
  });

  it("401 with a garbage token", async () => {
    const res = await guardedApp("proxy:call").request(
      "/probe",
      { headers: { "X-Authorization": "Bearer not-a-jwt" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("403 when the token lacks the scope", async () => {
    const token = await mint({ scopes: ["proxy:call"] });
    const res = await guardedApp("admin").request(
      "/probe",
      { headers: { "X-Authorization": `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("200 with a matching scope", async () => {
    const token = await mint({ scopes: ["admin"] });
    const res = await guardedApp("admin").request(
      "/probe",
      { headers: { "X-Authorization": `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scopes: ["admin"] });
  });

  it("accepts any of several scopes", async () => {
    const token = await mint({ scopes: ["proxy:call"] });
    const res = await guardedApp("proxy:call", "admin").request(
      "/probe",
      { headers: { "X-Authorization": `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("falls back to Authorization when X-Authorization is absent (OpenAI-client style)", async () => {
    const token = await mint({ scopes: ["admin"] });
    const res = await guardedApp("admin").request(
      "/probe",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
  });
});

/** Per-integration restriction. */
describe("isPermitted()", () => {
  it("unrestricted when no integrations claim", () => {
    expect(isPermitted({ payload: undefined, id: "openai" })).toBe(true);
    expect(isPermitted({ payload: { scopes: ["proxy:call"] }, id: "openai" })).toBe(true);
  });

  it("restricts to listed integrations", () => {
    const payload = { integrations: [{ id: "stripe" }, { id: "axiom" }] };
    expect(isPermitted({ payload, id: "stripe" })).toBe(true);
    expect(isPermitted({ payload, id: "openai" })).toBe(false);
  });

  it("rejects non-object entries", () => {
    const payload = { integrations: ["stripe"] };
    expect(isPermitted({ payload, id: "stripe" })).toBe(false);
  });
});

/** Unified only/except rule evaluation (Hono route syntax for paths). */
describe("isRuleAllowed()", () => {
  it("unrestricted when no rules", () => {
    expect(isRuleAllowed({ pathname: "/v1/models", method: "POST" })).toBe(true);
  });

  it("except.paths deny matching paths", () => {
    const except = { paths: ["/v1/private/*"] };
    expect(isRuleAllowed({ except, pathname: "/v1/private/keys" })).toBe(false);
    expect(isRuleAllowed({ except, pathname: "/v1/models" })).toBe(true);
  });

  it("only.paths require a match (Hono wildcard)", () => {
    const only = { paths: ["/v1/*"] };
    expect(isRuleAllowed({ only, pathname: "/v1/models" })).toBe(true);
    expect(isRuleAllowed({ only, pathname: "/v2/models" })).toBe(false);
  });

  it("paths support :params and regex params", () => {
    const only = { paths: ["/users/:id", "/orders/:id{\\d+}"] };
    expect(isRuleAllowed({ only, pathname: "/users/42" })).toBe(true);
    expect(isRuleAllowed({ only, pathname: "/orders/42" })).toBe(true);
    expect(isRuleAllowed({ only, pathname: "/orders/abc" })).toBe(false);
    expect(isRuleAllowed({ only, pathname: "/billing" })).toBe(false);
  });

  it("an empty only.methods denies everything", () => {
    expect(isRuleAllowed({ only: { methods: [] }, pathname: "/v1/models", method: "GET" })).toBe(
      false,
    );
  });

  it("except wins over only", () => {
    const only = { paths: ["/v1/*"] };
    const except = { paths: ["/v1/admin/*"] };
    expect(isRuleAllowed({ only, except, pathname: "/v1/models" })).toBe(true);
    expect(isRuleAllowed({ only, except, pathname: "/v1/admin/hidden" })).toBe(false);
  });

  it("METHOD /path entries also gate on method", () => {
    const only = { paths: ["GET /v1/models", "/v1/messages"] };
    expect(isRuleAllowed({ only, pathname: "/v1/models", method: "GET" })).toBe(true);
    expect(isRuleAllowed({ only, pathname: "/v1/models", method: "POST" })).toBe(false);
    expect(isRuleAllowed({ only, pathname: "/v1/messages", method: "POST" })).toBe(true);
    expect(isRuleAllowed({ only, pathname: "/v2/*", method: "GET" })).toBe(false);
  });

  it("METHOD /path works in except (case-insensitive method)", () => {
    const except = { paths: ["delete /v1/keys/*"] };
    expect(isRuleAllowed({ except, pathname: "/v1/keys/42", method: "DELETE" })).toBe(false);
    expect(isRuleAllowed({ except, pathname: "/v1/keys/42", method: "GET" })).toBe(true);
  });

  it("only.methods restrict to exactly those (read-only switch)", () => {
    const only = { methods: ["GET", "HEAD"] };
    expect(isRuleAllowed({ only, pathname: "/x", method: "GET" })).toBe(true);
    expect(isRuleAllowed({ only, pathname: "/x", method: "head" })).toBe(true); // case-insensitive
    expect(isRuleAllowed({ only, pathname: "/x", method: "POST" })).toBe(false);
  });

  it("except.methods deny matching methods", () => {
    const except = { methods: ["DELETE"] };
    expect(isRuleAllowed({ except, pathname: "/x", method: "DELETE" })).toBe(false);
    expect(isRuleAllowed({ except, pathname: "/x", method: "POST" })).toBe(true);
  });

  it("except wins over only for methods", () => {
    const only = { methods: ["GET", "PUT"] };
    const except = { methods: ["PUT"] };
    expect(isRuleAllowed({ only, except, pathname: "/x", method: "GET" })).toBe(true);
    expect(isRuleAllowed({ only, except, pathname: "/x", method: "PUT" })).toBe(false);
  });
});

/** Per-item rules narrow siblings independently. */
describe("isItemAllowed()", () => {
  const payload = {
    integrations: [{ id: "stripe" }, { id: "razorpay", only: { methods: ["GET", "HEAD"] } }],
  };

  it("unrestricted grant allows everything", () => {
    expect(isItemAllowed({ payload, id: "stripe", pathname: "/v1/charges", method: "POST" })).toBe(
      true,
    );
  });

  it("per-item only restricts that item while siblings stay broad", () => {
    expect(
      isItemAllowed({ payload, id: "razorpay", pathname: "/v1/payments", method: "GET" }),
    ).toBe(true);
    expect(
      isItemAllowed({ payload, id: "razorpay", pathname: "/v1/payments", method: "POST" }),
    ).toBe(false);
  });

  it("unlisted id passes item rules (membership is isPermitted)", () => {
    expect(isItemAllowed({ payload, id: "openai", pathname: "/x", method: "GET" })).toBe(true);
  });
});

/** Global rules apply uniformly. */
describe("isGloballyAllowed()", () => {
  it("unrestricted when no global rules", () => {
    expect(isGloballyAllowed({ payload: {}, pathname: "/v1/models", method: "POST" })).toBe(true);
  });

  it("global except denies", () => {
    const payload = { except: { methods: ["DELETE"] } };
    expect(isGloballyAllowed({ payload, pathname: "/x", method: "DELETE" })).toBe(false);
    expect(isGloballyAllowed({ payload, pathname: "/x", method: "GET" })).toBe(true);
  });

  it("global and per-item only intersect (narrow-only)", () => {
    const payload = {
      only: { methods: ["GET", "POST"] },
      integrations: [{ id: "razorpay", only: { methods: ["GET"] } }],
    };
    // item allows GET and global allows GET → allow (both gates pass independently)
    expect(
      isItemAllowed({ payload, id: "razorpay", pathname: "/v1/payments", method: "GET" }),
    ).toBe(true);
    expect(isGloballyAllowed({ payload, pathname: "/v1/payments", method: "GET" })).toBe(true);
    // item denies POST → denied even though global allows it
    expect(
      isItemAllowed({ payload, id: "razorpay", pathname: "/v1/payments", method: "POST" }),
    ).toBe(false);
  });
});
