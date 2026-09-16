import { describe, it, expect } from "vitest";
import { HeaderExpressionEngine } from "../engine";

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
