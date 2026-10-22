import { describe, it, expect, vi } from "vitest";
import { HeaderExpressionEngine } from "@/lib/engine";

/** Build a partial worker env, satisfying the type with just what a test needs. */
function makeEnv(extra: Record<string, unknown>): Env {
  return extra as unknown as Env;
}

describe("HeaderExpressionEngine secret sources", () => {
  it("kv() resolves via the KV store resolver", async () => {
    const engine = new HeaderExpressionEngine({
      kv: async (name, ns) => `KV:${ns ?? "default"}:${name}`,
      env: makeEnv({}),
    });
    expect(await engine.resolve("kv('OPENAI_API_KEY')")).toBe("KV:default:OPENAI_API_KEY");
    expect(await engine.resolve("kv('GITHUB_TOKEN', 'work')")).toBe("KV:work:GITHUB_TOKEN");
  });

  it("secret() reads a plain worker secret from env", async () => {
    const engine = new HeaderExpressionEngine({
      kv: async () => "unused",
      env: makeEnv({ STRIPE_SECRET_KEY: "sk-real-value" }),
    });
    expect(await engine.resolve("secret('STRIPE_SECRET_KEY')")).toBe("sk-real-value");
  });

  it("secret() fails loudly when the binding is missing or not a string", async () => {
    const engine = new HeaderExpressionEngine({ kv: async () => "unused", env: makeEnv({}) });
    await expect(engine.resolve("secret('MISSING')")).rejects.toThrow(/worker secret/);
  });

  it("secret_store() calls the binding's .get()", async () => {
    const engine = new HeaderExpressionEngine({
      kv: async () => "unused",
      env: makeEnv({ GUPSHUP_PASSWORD: { get: async () => "store-value" } }),
    });
    expect(await engine.resolve("secret_store('GUPSHUP_PASSWORD')")).toBe("store-value");
  });

  it("secret_store() fails loudly when the binding has no .get()", async () => {
    const engine = new HeaderExpressionEngine({
      kv: async () => "unused",
      env: makeEnv({ NOT_A_STORE: "plain-string" }),
    });
    await expect(engine.resolve("secret_store('NOT_A_STORE')")).rejects.toThrow(/\.get\(\)/);
  });

  it("variable() reads a plain-text env value (coerced to string)", async () => {
    const engine = new HeaderExpressionEngine({
      kv: async () => "unused",
      env: makeEnv({ APP_REGION: "eu", ACCOUNT_ID: 1234 }),
    });
    expect(await engine.resolve("variable('APP_REGION')")).toBe("eu");
    expect(await engine.resolve("variable('ACCOUNT_ID')")).toBe("1234"); // scalar → string
  });

  it("process_env() reads process.env (standalone Node/Bun host)", async () => {
    const name = "HODOR_TEST_PROCESS_ENV_" + Math.random().toString(36).slice(2);
    process.env[name] = "host-value";
    try {
      const engine = new HeaderExpressionEngine({ kv: async () => "unused", env: makeEnv({}) });
      expect(await engine.resolve(`process_env('${name}')`)).toBe("host-value");
    } finally {
      delete process.env[name];
    }
  });

  it("process_env() fails loudly when the var is unset", async () => {
    const engine = new HeaderExpressionEngine({ kv: async () => "unused", env: makeEnv({}) });
    await expect(engine.resolve("process_env('HODOR_DEFINITELY_UNSET')")).rejects.toThrow(
      /not set in process.env/,
    );
  });

  it("process_env is reserved and cannot be shadowed", async () => {
    await expect(
      () =>
        new HeaderExpressionEngine({
          kv: async () => "unused",
          env: makeEnv({}),
          extra: { process_env: () => "x" },
        }),
    ).toThrow(/Cannot override reserved helper/);
  });

  it("variable() fails loudly when missing or non-scalar", async () => {
    const engine = new HeaderExpressionEngine({
      kv: async () => "unused",
      env: makeEnv({ OBJ: { a: 1 } }),
    });
    await expect(engine.resolve("variable('MISSING')")).rejects.toThrow(/no env variable/);
    await expect(engine.resolve("variable('OBJ')")).rejects.toThrow(/not plain text/);
  });
});

/** Encode DER bytes as a PEM block for test fixtures. */
function derToPem(der: ArrayBuffer, label: string): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

/** Decode a base64url JWT segment in tests (node env). */
function decodeSegment(segment: string): Record<string, unknown> {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** Generate a sign/verify key pair for tests (typed, unlike the union overload). */
async function genEcPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function genRsaPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

/** Export a private key as PKCS8 DER for tests. */
async function exportPkcs8(key: CryptoKey): Promise<ArrayBuffer> {
  return (await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer;
}

describe("HeaderExpressionEngine jwt()", () => {
  it("signs ES256 and verifies with the public key", async () => {
    const pair = await genEcPair();
    const pem = derToPem(await exportPkcs8(pair.privateKey), "PRIVATE KEY");
    const engine = new HeaderExpressionEngine({
      kv: async (name) =>
        ({ KEY: pem, KID: "key-1", ISS: "issuer-1", BID: "com.example.app" })[name] ?? "missing",
      env: makeEnv({}),
    });
    const token = await engine.resolve(
      "jwt({alg: 'ES256', key: kv('KEY'), kid: kv('KID'), ttl: 600, claims: {iss: kv('ISS'), aud: 'appstoreconnect-v1', bid: kv('BID')}})",
    );
    const [h, p, s] = token.split(".");
    expect(decodeSegment(h)).toMatchObject({ alg: "ES256", typ: "JWT", kid: "key-1" });
    const claims = decodeSegment(p);
    expect(claims).toMatchObject({ iss: "issuer-1", aud: "appstoreconnect-v1", bid: "com.example.app" });
    expect(typeof claims["iat"]).toBe("number");
    expect((claims["exp"] as number) - (claims["iat"] as number)).toBe(600);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      Uint8Array.from(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
  it("accepts PEM with literal backslash-n line breaks (1Password form)", async () => {
    const backslashPair = await genEcPair();
    const backslashPem = derToPem(await exportPkcs8(backslashPair.privateKey), "PRIVATE KEY");
    const backslashEngine = new HeaderExpressionEngine({
      kv: async () => backslashPem.replace(/\n/g, "\\n"),
      env: makeEnv({}),
    });
    const backslashToken = await backslashEngine.resolve(
      "jwt({alg: 'ES256', key: kv('KEY'), ttl: 60, claims: {aud: 'x'}})",
    );
    expect(backslashToken.split(".").length).toBe(3);
  });

  it("signs RS256 and caller claims win over injected iat/exp", async () => {
    const pair = await genRsaPair();
    const pem = derToPem(await exportPkcs8(pair.privateKey), "PRIVATE KEY");
    const engine = new HeaderExpressionEngine({ kv: async () => pem, env: makeEnv({}) });
    const token = await engine.resolve(
      "jwt({alg: 'RS256', key: kv('KEY'), ttl: 3600, claims: {iss: 'svc@example.iam', scope: 's', aud: 'https://oauth2.googleapis.com/token', iat: 1, exp: 2}})",
    );
    const [h, p, s] = token.split(".");
    expect(decodeSegment(h)).toMatchObject({ alg: "RS256" });
    expect(decodeSegment(p)).toMatchObject({ iat: 1, exp: 2 });
    const ok = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      pair.publicKey,
      Uint8Array.from(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("fails loudly on bad alg, bad key, and non-object opts", async () => {
    const engine = new HeaderExpressionEngine({ kv: async () => "x", env: makeEnv({}) });
    await expect(engine.resolve("jwt({alg: 'HS256', key: kv('K'), claims: {}})")).rejects.toThrow(
      /unsupported alg/,
    );
    await expect(engine.resolve("jwt({alg: 'ES256', key: 'not-a-key', claims: {}})")).rejects.toThrow(
      /PEM/,
    );
    await expect(engine.resolve("jwt('ES256')")).rejects.toThrow(/one object/);
  });
});

describe("HeaderExpressionEngine google_oauth()", () => {
  it("exchanges once then serves from cache", async () => {
    const pair = await genRsaPair();
    const pem = derToPem(await exportPkcs8(pair.privateKey), "PRIVATE KEY");
    const account = JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: pem });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      (async () => {
        calls++;
        return new Response(JSON.stringify({ access_token: "tok-123", expires_in: 3600 }), {
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    );
    try {
      const engine = new HeaderExpressionEngine({ kv: async () => account, env: makeEnv({}) });
      const expr =
        "google_oauth({account: kv('SA'), scope: 'https://www.googleapis.com/auth/androidpublisher'})";
      expect(await engine.resolve(expr)).toBe("tok-123");
      expect(await engine.resolve(expr)).toBe("tok-123");
      expect(calls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails loudly on invalid account JSON and failed exchange", async () => {
    const engine = new HeaderExpressionEngine({ kv: async () => "not-json", env: makeEnv({}) });
    await expect(engine.resolve("google_oauth({account: kv('SA'), scope: 's'})")).rejects.toThrow(
      /not valid JSON/,
    );
    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 401 })) as typeof fetch);
    try {
      const failPair = await genRsaPair();
      const failPem = derToPem(await exportPkcs8(failPair.privateKey), "PRIVATE KEY");
      const engine2 = new HeaderExpressionEngine({
        kv: async () => JSON.stringify({ client_email: "e", private_key: failPem }),
        env: makeEnv({}),
      });
      await expect(engine2.resolve("google_oauth({account: kv('SA'), scope: 's'})")).rejects.toThrow(
        /HTTP 401/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
