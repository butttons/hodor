import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";

import type { AppEnv } from "@/utils";
import { authMiddleware } from "@/lib/auth";
import { proxyApp } from "@/routes/proxy";
import { kvStore } from "@/lib/runtime";

/** Test-only HMAC secret (must match nothing in production). */
const TEST_SECRET = "test-secret-for-proxy-spec-only-0123456789";

/** A valid base64 AES-256 key (32 bytes) for the encrypted secret store. */
const HODOR_ENCRYPTION_KEY = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 251)),
);

/** A minimal KVNamespace mock storing values in-memory (matches revocation.spec). */
function mockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  } as unknown as KVNamespace;
}

/** A fresh env + seeded registry item (`r:test`) for one proxied call. */
async function makeEnv() {
  const kv = mockKV();
  const storage = await kvStore({ binding: kv });
  await storage.setItem("r:test", {
    id: "test",
    url: { host: "httpbin.org" },
    headers: { "x-item": "'static-value'" },
    meta: { label: "Test service", description: "A test upstream" },
  });
  const env = {
    HODOR_JWT_SECRET: TEST_SECRET,
    HODOR_ENCRYPTION_KEY,
    HODOR_KV: kv,
  } as unknown as Env;
  return { storage, env };
}

/** Sign a JWT the way POST /_admin/keys does. */
async function mint(env: Env, payload: Record<string, unknown>): Promise<string> {
  return sign(
    { iat: Math.floor(Date.now() / 1000) - 60, exp: 9999999999, ...payload },
    TEST_SECRET,
  );
}

/** Wire the same error envelope the worker uses. */
function withErrorHandling(app: Hono<AppEnv>): Hono<AppEnv> {
  return app.onError((error, c) => {
    const e = error as { status?: number; toJSON?: () => unknown };
    if (typeof e.status === "number" && typeof e.toJSON === "function") {
      return c.json(e.toJSON(), e.status as never);
    }
    return c.json({ code: "INTERNAL_ERROR", message: (error as Error).message, status: 500 }, 500);
  });
}

const execCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /probe through a registry item (consumer identity)", () => {
  it("stamps key name + id, and ctx when claimed", async () => {
    const { env } = await makeEnv();
    const token = await mint(env, {
      jti: "j-1",
      name: "ci-runner",
      scopes: ["proxy:call"],
      ctx: { run: "nightly" },
    });
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = withErrorHandling(new Hono<AppEnv>().use("*", authMiddleware).route("/", proxyApp));
    const res = await app.request(
      "http://test.example/probe",
      {
        method: "GET",
        headers: { host: "test.example", "x-authorization": `Bearer ${token}` },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(200);

    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(init?.headers);
    expect(headers.get("x-hodor-key")).toBe("ci-runner");
    expect(headers.get("x-hodor-key-id")).toBe("j-1");
    expect(headers.get("x-hodor-ctx")).toBe('{"run":"nightly"}');
    // Caller JWT never reaches the upstream; the item's static header still applies.
    expect(headers.get("x-authorization")).toBeNull();
    expect(headers.get("x-item")).toBe("static-value");
  });

  it("omits the ctx header when the token has no ctx claim", async () => {
    const { env } = await makeEnv();
    const token = await mint(env, { jti: "j-2", name: "plain", scopes: ["proxy:call"] });
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = withErrorHandling(new Hono<AppEnv>().use("*", authMiddleware).route("/", proxyApp));
    await app.request(
      "http://test.example/probe",
      {
        method: "GET",
        headers: { host: "test.example", "x-authorization": `Bearer ${token}` },
      },
      env,
      execCtx,
    );
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(init?.headers);
    expect(headers.get("x-hodor-key")).toBe("plain");
    expect(headers.get("x-hodor-key-id")).toBe("j-2");
    expect(headers.get("x-hodor-ctx")).toBeNull();
  });

  it("strips client-forged identity headers before stamping", async () => {
    const { env } = await makeEnv();
    const token = await mint(env, { jti: "j-3", name: "trusted", scopes: ["proxy:call"] });
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = withErrorHandling(new Hono<AppEnv>().use("*", authMiddleware).route("/", proxyApp));
    await app.request(
      "http://test.example/probe",
      {
        method: "GET",
        headers: {
          host: "test.example",
          "x-authorization": `Bearer ${token}`,
          "x-hodor-key": "forged",
          "x-hodor-key-id": "forged-jti",
          "x-hodor-ctx": "forged-ctx",
        },
      },
      env,
      execCtx,
    );
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(init?.headers);
    // The real, verified identity wins; nothing forged survives.
    expect(headers.get("x-hodor-key")).toBe("trusted");
    expect(headers.get("x-hodor-key-id")).toBe("j-3");
    expect(headers.get("x-hodor-ctx")).toBeNull();
  });
});
