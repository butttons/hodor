import { describe, it, expect, afterEach, vi } from "vitest";
import { sign } from "hono/jwt";
import app from "../../index";
import { kvStore } from "../../lib/runtime";

/** Test-only HMAC secret (must match nothing in production). */
const TEST_SECRET = "test-secret-for-host-gate-spec-only-0123456789";

/** A valid base64 AES-256 key (32 bytes) for the encrypted secret store. */
const HODOR_ENCRYPTION_KEY = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 251)),
);

function mockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  } as unknown as KVNamespace;
}

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
    HODOR_APP_URL: "https://example.com",
  } as unknown as Env;
  return { storage, env };
}

const execCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function mintToken(env: Env, payload: Record<string, unknown>): Promise<string> {
  return sign(
    { iat: Math.floor(Date.now() / 1000) - 60, exp: 9999999999, ...payload },
    TEST_SECRET,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("control surface lives under /_ and is main-host only", () => {
  it("serves admin + reflection + minting under /_ on the main host", async () => {
    const { env } = await makeEnv();
    const admin = await mintToken(env, { jti: "j1", name: "admin", scopes: ["admin"] });

    const health = await app.request(
      "https://example.com/_/admin/health",
      { headers: { host: "example.com", "X-Authorization": `Bearer ${admin}` } },
      env,
      execCtx,
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ healthy: true });

    const reflection = await app.request(
      "https://example.com/_/reflection",
      { headers: { host: "example.com", "X-Authorization": `Bearer ${admin}` } },
      env,
      execCtx,
    );
    expect(reflection.status).toBe(200);
    const payload = (await reflection.json()) as { services: { id: string }[] };
    expect(payload.services.map((s) => s.id)).toEqual(["test"]);
    expect(payload).toMatchObject({ baseUrl: "https://example.com" });

    const mint = await app.request(
      "https://example.com/_/keys",
      {
        method: "POST",
        headers: { host: "example.com", "content-type": "application/json" },
        body: JSON.stringify({ secret: TEST_SECRET, name: "k", scopes: ["proxy:call"] }),
      },
      env,
      execCtx,
    );
    expect(mint.status).toBe(201);

    const ledger = await app.request(
      "https://example.com/_/admin/keys",
      { headers: { host: "example.com", "X-Authorization": `Bearer ${admin}` } },
      env,
      execCtx,
    );
    expect(ledger.status).toBe(200);
    const body = (await ledger.json()) as {
      keys: { name: string; revoked: boolean; expired: boolean }[];
    };
    const key = body.keys.find((k) => k.name === "k");
    expect(key).toBeDefined();
    expect(typeof key?.revoked).toBe("boolean");
    expect(typeof key?.expired).toBe("boolean");
  });
});

describe("subdomains always forward — never control", () => {
  it("never serves control endpoints on a subdomain (admin token → proxy pipeline)", async () => {
    const { env } = await makeEnv();
    const admin = await mintToken(env, { jti: "j2", name: "admin", scopes: ["admin"] });

    const response = await app.request(
      "https://test.example.com/_/admin/health",
      { headers: { host: "test.example.com", "X-Authorization": `Bearer ${admin}` } },
      env,
      execCtx,
    );
    const body = await response.text();
    expect(response.status, body).toBe(403); // proxy pipeline: admin token has no proxy:call
  });

  it("forwards /_ paths on subdomains to the registry target upstream", async () => {
    const { env } = await makeEnv();
    const proxy = await mintToken(env, {
      jti: "j3",
      name: "p",
      scopes: ["proxy:call"],
      integrations: [{ id: "test" }],
    });

    const fetchMock = vi.fn(async (input: Request) => new Response("upstream-hit"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request(
      "https://test.example.com/_/admin/health",
      { headers: { host: "test.example.com", "X-Authorization": `Bearer ${proxy}` } },
      env,
      execCtx,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toBe("upstream-hit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The upstream path keeps the caller's full path (e.g. /_/admin/health).
    expect(String(fetchMock.mock.calls[0][0])).toContain("httpbin.org/_/admin/health");
  });

  it("the old /_admin path no longer serves control on the apex", async () => {
    const { env } = await makeEnv();
    const admin = await mintToken(env, { jti: "j4", name: "admin", scopes: ["admin"] });
    const response = await app.request(
      "https://example.com/_admin/health",
      { headers: { host: "example.com", "X-Authorization": `Bearer ${admin}` } },
      env,
      execCtx,
    );
    // Not the admin endpoint (that would be 200); admin token hits the proxy scope check.
    expect(response.status).toBe(403);
  });
});
