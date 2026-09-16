/**
 * Header-expression engine for registry items.
 *
 * Registry items store header values as JEXL expressions, evaluated with
 * "normal jexl rules" — no `${}` template transpiling. A static header is a
 * JEXL string literal:
 *
 *   "Authorization": "'Bearer ' + kv('OPENAI_API_KEY')"
 *   "Content-Type":  "'application/json'"
 *   "X-Token":       "'Basic ' + base64(kv('ID') + ':' + kv('SECRET'))"
 *
 * Four env/secret sources are exposed as JEXL functions. `kv()` is the default
 * (managed via the admin API /_admin/secrets):
 *   - `kv('NAME'[, 'ns'])`  — the encrypted KV secret store (this project's own)
 *   - `secret('NAME')`      — a plain Cloudflare worker secret binding via `env.[name]`
 *   - `secret_store('NAME')` — a Cloudflare Secrets Store binding via `env.[name].get()`
 *   - `variable('NAME')`    — a plain-text env value via `env.[name]` (non-secret config)
 *
 * A hardened runtime exposes a small helper library (base64, json, ...) for
 * building auth headers. Anything that isn't a valid expression throws, so a
 * malformed config fails loudly rather than proxying a broken header.
 *
 * Authoring rules (normal jexl):
 * - Every value is a JEXL expression. A static header is a JEXL string literal:
 *     "Content-Type": "'application/json'"
 * - Interpolate secrets with kv('NAME') / secret('NAME') / secret_store('NAME'):
 *     "Authorization": "'Bearer ' + kv('OPENAI_API_KEY')"
 * - Build Basic auth with base64:
 *     "X-Auth": "'Basic ' + base64(kv('ID') + ':' + kv('SECRET'))"
 * - Bare unquoted text (e.g. `application/json`) is invalid and will throw —
 *   when in doubt, wrap a literal in quotes.
 *
 * @module
 */
import jexl from "jexl";

/** Resolves a secret from the encrypted KV store (name, optional namespace). */
export type SecretResolver = (name: string, namespace?: string) => Promise<string>;

/** Extra JEXL functions a caller may register, beyond the built-ins. */
export type HelperMap = Record<string, (...args: unknown[]) => unknown>;

/** Thrown for unresolvable secrets, reserved overrides, or invalid calls. */
export class HeaderExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeaderExpressionError";
  }
}

/** Built-in / reserved function names; callers may not silently shadow them. */
const RESERVED = new Set([
  "kv",
  "secret",
  "secret_store",
  "process_env",
  "variable",
  "base64",
  "base64url",
  "json",
  "upper",
  "lower",
  "trim",
  "urlencode",
]);

/** Base64-encode a UTF-8 string (safe for non-ASCII input). */
function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64url-encode a UTF-8 string (URL-safe, no padding). */
function toBase64Url(input: string): string {
  return toBase64(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Built-in helpers registered on every runtime. */
const builtInHelpers: HelperMap = {
  base64: (input) => toBase64(String(input)),
  base64url: (input) => toBase64Url(String(input)),
  json: (value) => JSON.stringify(value),
  upper: (input) => String(input).toUpperCase(),
  lower: (input) => String(input).toLowerCase(),
  trim: (input) => String(input).trim(),
  urlencode: (input) => encodeURIComponent(String(input)),
};

/** Constructor inputs for {@link HeaderExpressionEngine}. */
export interface HeaderExpressionEngineInput {
  /** Resolver for the encrypted KV secret store (`kv('NAME')`). */
  kv: SecretResolver;
  /** Worker bindings; `secret()` reads `env.[name]`, `secret_store()` calls `env.[name].get()`. */
  env: Env;
  /** Additional JEXL functions to expose, beyond the built-ins. */
  extra?: HelperMap;
}

/**
 * Evaluates registry header templates as JEXL expressions.
 *
 * Each instance owns a fresh JEXL runtime so registrations are isolated
 * between workers and cannot leak across callers.
 */
export class HeaderExpressionEngine {
  private readonly runtime: InstanceType<typeof jexl.Jexl>;

  /**
   * @throws {@link HeaderExpressionError} if `input.extra` shadows a reserved
   *         helper name.
   */
  constructor(input: HeaderExpressionEngineInput) {
    const extra = input.extra ?? {};
    for (const name of Object.keys(extra)) {
      if (RESERVED.has(name)) {
        throw new HeaderExpressionError(`Cannot override reserved helper "${name}"`);
      }
    }
    this.runtime = new jexl.Jexl();
    this.runtime.addFunction("kv", (name, namespace) => {
      if (typeof name !== "string" || name.length === 0) {
        throw new HeaderExpressionError("kv() requires a non-empty name");
      }
      const ns = typeof namespace === "string" && namespace.length > 0 ? namespace : undefined;
      return input.kv(name, ns);
    });
    this.runtime.addFunction("secret", (name) => {
      if (typeof name !== "string" || name.length === 0) {
        throw new HeaderExpressionError("secret() requires a non-empty name");
      }
      const value = (input.env as unknown as Record<string, unknown>)[name];
      if (typeof value !== "string") {
        throw new HeaderExpressionError(
          `secret('${name}') — no plain worker secret named \`${name}\` (got ${typeof value})`,
        );
      }
      return value;
    });
    this.runtime.addFunction("secret_store", (name) => {
      if (typeof name !== "string" || name.length === 0) {
        throw new HeaderExpressionError("secret_store() requires a non-empty name");
      }
      const binding = (input.env as unknown as Record<string, unknown>)[name];
      if (
        !binding ||
        typeof binding !== "object" ||
        typeof (binding as { get?: unknown })["get"] !== "function"
      ) {
        throw new HeaderExpressionError(
          `secret_store('${name}') — \`${name}\` is not a Secrets Store binding (missing .get())`,
        );
      }
      return (binding as { get: () => Promise<string> }).get();
    });
    this.runtime.addFunction("variable", (name) => {
      if (typeof name !== "string" || name.length === 0) {
        throw new HeaderExpressionError("variable() requires a non-empty name");
      }
      const value = (input.env as unknown as Record<string, unknown>)[name];
      // Plain-text config (e.g. a `vars` entry like HODOR_APP_URL), not a credential:
      // any scalar is acceptable, coerced to a string.
      if (value === undefined || value === null) {
        throw new HeaderExpressionError(`variable('${name}') — no env variable named \`${name}\``);
      }
      if (typeof value === "object") {
        throw new HeaderExpressionError(
          `variable('${name}') — env value is an object, not plain text`,
        );
      }
      return String(value);
    });
    // Host process env, for standalone Node/Bun servers: `process.env[NAME]`.
    // Empty on Workers (no process env to read) — that's the point. Unlike
    // `variable()` this reads the actual process even without bindings.
    this.runtime.addFunction("process_env", (name) => {
      if (typeof name !== "string" || name.length === 0) {
        throw new HeaderExpressionError("process_env() requires a non-empty name");
      }
      const processEnv = typeof process !== "undefined" ? process.env : undefined;
      const value = processEnv?.[name];
      if (value === undefined) {
        throw new HeaderExpressionError(`process_env('${name}') — not set in process.env`);
      }
      return value;
    });
    for (const [name, fn] of Object.entries({ ...builtInHelpers, ...extra })) {
      this.runtime.addFunction(name, fn);
    }
  }

  /**
   * Evaluate one header value as a JEXL expression, coerced to a string.
   *
   * Only string / non-NaN number / boolean results are accepted. Anything else
   * — including NaN, which JEXL produces for a bare unquoted value like
   * `application/json` (division of undefined vars) — throws, so a malformed
   * expression fails loudly instead of silently proxying a broken header.
   * JEXL's own parse/runtime errors are normalized to
   * {@link HeaderExpressionError} so callers handle exactly one error class.
   *
   * @param expression The JEXL expression to evaluate.
   * @returns The resolved header value.
   * @throws {HeaderExpressionError} When the expression is malformed or its
   *         result cannot be represented as a header string.
   */
  async resolve(expression: string): Promise<string> {
    const trimmed = expression.trim();
    if (trimmed.length === 0) return "";
    let result: unknown;
    try {
      result = await this.runtime.eval(expression);
    } catch (cause) {
      throw new HeaderExpressionError(
        `Failed to evaluate header expression ${JSON.stringify(expression)}: ${(cause as Error).message}`,
      );
    }
    if (typeof result === "string") return result;
    if (typeof result === "number") {
      if (Number.isNaN(result)) {
        throw new HeaderExpressionError(
          `Expression evaluated to NaN (is a literal missing quotes?): ${JSON.stringify(expression)}`,
        );
      }
      return String(result);
    }
    if (typeof result === "boolean") return String(result);
    throw new HeaderExpressionError(
      `Expression produced unsupported result type (${typeof result}) — use json() to build strings: ${JSON.stringify(expression)}`,
    );
  }

  /**
   * Resolve every header in a map, preserving key order.
   * Wraps & resolves in parallel, failing closed on the first error.
   */
  async resolveHeaders(headers: Record<string, string>): Promise<Record<string, string>> {
    const entries = Object.entries(headers);
    const values = await Promise.all(entries.map(([, value]) => this.resolve(value)));
    const out: Record<string, string> = {};
    for (let index = 0; index < entries.length; index++) out[entries[index][0]] = values[index];
    return out;
  }
}
