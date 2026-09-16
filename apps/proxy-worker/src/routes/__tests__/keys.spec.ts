import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { verify } from "hono/jwt";

import type { AppEnv } from "@/utils";
import { getMintStore } from "@/lib/mints";
import { kvStore } from "@/lib/runtime";
import { keysApp } from "@/routes/keys";

/** Test-only HMAC secret. */
const TEST_SECRET = "test-secret-for-keys-spec-only-0123456789";

const env = { HODOR_JWT_SECRET: TEST_SECRET } as unknown as Env;

/** Wire the worker's error envelope so AppHTTPException maps to its status. */
const app = new Hono<AppEnv>().route("/_admin/keys", keysApp).onError((error, c) => {
  const e = error as { status?: number; toJSON?: () => unknown; message?: string };
  if (typeof e.status === "number" && typeof e.toJSON === "function")
    return c.json(e.toJSON(), e.status as never);
  return c.json({ code: "INTERNAL_ERROR", message: (error as Error).message, status: 500 }, 500);
});

const post = (body: Record<string, unknown>) =>
  app.request(
    "/_admin/keys",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

/** The mint path is deliberately unauthenticated — keyed only by body secret. */
describe("POST /_admin/keys (unauthenticated mint)", () => {
  it("mints a key without any X-Authorization header", async () => {
    const res = await post({ secret: TEST_SECRET, name: "ci-key", scopes: ["proxy:call"] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: string;
      jti: string;
      scopes: string[];
      exp: number;
    };
    const payload = await verify(body.token, TEST_SECRET, "HS256");
    expect(payload.name).toBe("ci-key");
    expect(payload.scopes).toEqual(["proxy:call"]);
    expect(body.exp).toBe(payload.exp);
  });

  it("409 on a duplicate live name, reusable after revoke", async () => {
    const first = await post({ secret: TEST_SECRET, name: "dup-key", scopes: ["proxy:call"] });
    expect(first.status).toBe(201);
    const clash = await post({ secret: TEST_SECRET, name: "dup-key", scopes: ["proxy:call"] });
    expect(clash.status).toBe(409);
    const body = (await clash.json()) as { message: string };
    expect(body.message).toContain("dup-key");
    const { jti } = (await first.json()) as { jti: string };
    const { getRevocationStore } = await import("@/lib/revocation");
    await getRevocationStore(await kvStore({})).revoke(jti);
    const retry = await post({ secret: TEST_SECRET, name: "dup-key", scopes: ["proxy:call"] });
    expect(retry.status).toBe(201);
  });

  it("records the mint in the KV ledger (metadata, never the token)", async () => {
    const res = await post({
      secret: TEST_SECRET,
      name: "ledger-key",
      scopes: ["proxy:call"],
      integrations: [{ id: "axiom" }],
    });
    expect(res.status).toBe(201);
    const ledger = await getMintStore(await kvStore({})).list();
    const match = ledger.find((m) => m.name === "ledger-key");
    expect(match).toBeDefined();
    expect(match).toMatchObject({ scopes: ["proxy:call"], integrations: [{ id: "axiom" }] });
    expect(JSON.stringify(match)).not.toContain("token");
  });

  it("401 with the wrong secret", async () => {
    const res = await post({ secret: "nope", name: "evil", scopes: ["admin"] });
    expect(res.status).toBe(401);
  });

  it("400 on an invalid body", async () => {
    const noScopes = await post({ secret: TEST_SECRET, name: "x", scopes: [] });
    expect(noScopes.status).toBe(400);
    const noche = await post({ secret: TEST_SECRET }); // missing name/scopes
    expect(noche.status).toBe(400);
    const untrusted = await post({ secret: TEST_SECRET, name: "x", scopes: ["root"] });
    expect(untrusted.status).toBe(400);
    const bareString = await post({
      secret: TEST_SECRET,
      name: "x",
      scopes: ["proxy:call"],
      integrations: ["stripe"],
    });
    expect(bareString.status).toBe(400);
  });

  it("carries integration + path restrictions in the token claims", async () => {
    const res = await post({
      secret: TEST_SECRET,
      name: "restricted",
      scopes: ["proxy:call"],
      integrations: [{ id: "stripe" }, { id: "razorpay", only: { methods: ["GET"] } }],
      only: { paths: ["/v1/*"] },
      except: { paths: ["/v1/private/*"] },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string };
    const payload = await verify(body.token, TEST_SECRET, "HS256");
    expect(payload.integrations).toEqual([
      { id: "stripe" },
      { id: "razorpay", only: { methods: ["GET"] } },
    ]);
    expect(payload.only).toEqual({ paths: ["/v1/*"] });
    expect(payload.except).toEqual({ paths: ["/v1/private/*"] });
  });

  it("honors expiresInSeconds in the exp claim", async () => {
    const res = await post({
      secret: TEST_SECRET,
      name: "short",
      scopes: ["proxy:call"],
      expiresInSeconds: 3600,
    });
    const body = (await res.json()) as { exp: number };
    const iat = Math.floor(Date.now() / 1000);
    expect(body.exp).toBeGreaterThanOrEqual(iat + 3599);
    expect(body.exp).toBeLessThanOrEqual(iat + 3601);
  });

  it("carries an optional ctx claim for upstream consumer identity", async () => {
    const ctx = { run: "nightly", repo: "hodor" };
    const res = await post({
      secret: TEST_SECRET,
      name: "ci",
      scopes: ["proxy:call"],
      ctx,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; ctx: unknown };
    expect(body.ctx).toEqual(ctx);
    const payload = await verify(body.token, TEST_SECRET, "HS256");
    expect(payload.ctx).toEqual(ctx);
  });
});
