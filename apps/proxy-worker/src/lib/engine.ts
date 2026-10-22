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
 * Two signing helpers cover JWT-based upstreams (Apple, Google) without any
 * external refresher — tokens are minted at request time from keys in the
 * secret stores above:
 *   - `jwt({alg, key, claims[, kid, typ, ttl]})` — compact JWS via WebCrypto.
 *     alg is 'ES256' or 'RS256', key a PKCS8 PEM string, claims an object;
 *     iat/exp default to now/now+ttl (ttl seconds, default 3600) unless the
 *     caller sets them. kid lands in the protected header.
 *   - `google_oauth({account, scope[, ttl]})` — service-account JWT-bearer
 *     exchange at oauth2.googleapis.com/token, returning an access token.
 *     account is the service-account JSON (client_email + private_key);
 *     tokens are cached in-isolate until expiry minus skew.
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
 * - Mint an Apple App Store Server API token at request time:
 *     "Authorization": "'Bearer ' + jwt({alg: 'ES256', key: kv('APPLE_PRIVATE_KEY'), kid: kv('APPLE_KEY_ID'), ttl: 3600, claims: {iss: kv('APPLE_ISSUER_ID'), aud: 'appstoreconnect-v1', bid: kv('APPLE_BUNDLE_ID')}})"
 * - Mint a Google access token via service-account exchange:
 *     "Authorization": "'Bearer ' + google_oauth({account: kv('ANDROID_SERVICE_ACCOUNT'), scope: 'https://www.googleapis.com/auth/androidpublisher'})"
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
  "jwt",
  "google_oauth",
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

/** Decode a PKCS8 PEM block to raw DER bytes. */
function pemToDer(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, "\n").replace(/\r/g, "");
  const base64 = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("-----"))
    .join("");
  if (base64.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw new HeaderExpressionError("jwt() — key is not a valid PEM block");
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** base64url-encode raw bytes (URL-safe, no padding). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Options for {@link signJwt}. */
export interface JwtOptions {
  alg: string;
  key: string;
  claims?: Record<string, unknown>;
  kid?: string;
  typ?: string;
  ttl?: number;
}

/**
 * Sign a compact JWS with a PKCS8 PEM private key via WebCrypto.
 * `iat`/`exp` default to now/now+ttl unless the caller sets them in claims.
 */
export async function signJwt(input: JwtOptions): Promise<string> {
  const { alg, key, claims = {}, kid, typ = "JWT", ttl = 3600 } = input;
  if (alg !== "ES256" && alg !== "RS256") {
    throw new HeaderExpressionError(
      `jwt() — unsupported alg ${JSON.stringify(alg)} (want 'ES256' or 'RS256')`,
    );
  }
  if (typeof key !== "string" || !key.includes("PRIVATE KEY")) {
    throw new HeaderExpressionError("jwt() — key must be a PKCS8 PEM private key string");
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    throw new HeaderExpressionError("jwt() — claims must be an object");
  }
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new HeaderExpressionError("jwt() — ttl must be a positive integer (seconds)");
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + ttl, ...claims };
  const importAlgo =
    alg === "ES256"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey("pkcs8", pemToDer(key), importAlgo, false, [
      "sign",
    ]);
  } catch {
    throw new HeaderExpressionError(`jwt() — key import failed (wrong key for ${alg}?)`);
  }
  const header = { alg, typ, ...(typeof kid === "string" && kid ? { kid } : {}) };
  const signingInput = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Options for {@link googleOAuth}. */
export interface GoogleOAuthOptions {
  account: string;
  scope: string;
  ttl?: number;
}

/** In-isolate cache of Google access tokens, keyed by service account + scope. */
const googleTokenCache = new Map<string, { token: string; exp: number }>();

/**
 * Service-account JWT-bearer exchange at oauth2.googleapis.com/token.
 * `account` is the service-account JSON (client_email + private_key).
 * Returns a cached access token when one is still valid (60s skew).
 */
export async function googleOAuth(input: GoogleOAuthOptions): Promise<string> {
  const { account, scope, ttl = 3600 } = input;
  if (typeof account !== "string" || account.length === 0 || typeof scope !== "string" || scope.length === 0) {
    throw new HeaderExpressionError(
      "google_oauth() — need {account: <service-account JSON>, scope: <oauth scope>}",
    );
  }
  let service: { client_email?: unknown; private_key?: unknown };
  try {
    service = JSON.parse(account);
  } catch {
    throw new HeaderExpressionError("google_oauth() — account is not valid JSON");
  }
  if (typeof service.client_email !== "string" || typeof service.private_key !== "string") {
    throw new HeaderExpressionError(
      "google_oauth() — account JSON needs client_email + private_key",
    );
  }
  const cacheKey = `${service.client_email}\n${scope}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = googleTokenCache.get(cacheKey);
  if (cached && cached.exp > nowSec + 60) return cached.token;
  const assertion = await signJwt({
    alg: "RS256",
    key: service.private_key,
    ttl: Math.min(ttl, 3600),
    claims: { iss: service.client_email, scope, aud: "https://oauth2.googleapis.com/token" },
  });
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
  } catch (cause) {
    throw new HeaderExpressionError(`google_oauth() — token exchange unreachable: ${(cause as Error).message}`);
  }
  if (!response.ok) {
    throw new HeaderExpressionError(`google_oauth() — token exchange failed (HTTP ${response.status})`);
  }
  const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new HeaderExpressionError("google_oauth() — exchange returned no access_token");
  }
  const lifetime = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  googleTokenCache.set(cacheKey, { token: data.access_token, exp: nowSec + lifetime });
  return data.access_token;
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
    // Request-time JWS signing for JWT-based upstreams (Apple, Google).
    // Single-object form — JEXL object literals may nest kv()/secret() calls:
    //   jwt({alg: 'ES256', key: kv('APPLE_PRIVATE_KEY'), kid: kv('APPLE_KEY_ID'),
    //        ttl: 3600, claims: {iss: kv('APPLE_ISSUER_ID'), aud: 'appstoreconnect-v1'}})
    this.runtime.addFunction("jwt", (opts: unknown) => {
      if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
        throw new HeaderExpressionError(
          "jwt() — pass one object: jwt({alg, key, claims[, kid, typ, ttl]})",
        );
      }
      const { alg, key, claims, kid, typ, ttl } = opts as Record<string, unknown>;
      if (typeof alg !== "string" || typeof key !== "string") {
        throw new HeaderExpressionError("jwt() — alg and key must be strings");
      }
      if (claims !== undefined && (typeof claims !== "object" || claims === null)) {
        throw new HeaderExpressionError("jwt() — claims must be an object");
      }
      if (kid !== undefined && typeof kid !== "string") {
        throw new HeaderExpressionError("jwt() — kid must be a string");
      }
      if (typ !== undefined && typeof typ !== "string") {
        throw new HeaderExpressionError("jwt() — typ must be a string");
      }
      if (ttl !== undefined && (typeof ttl !== "number" || !Number.isInteger(ttl))) {
        throw new HeaderExpressionError("jwt() — ttl must be an integer (seconds)");
      }
      return signJwt({
        alg,
        key,
        claims: (claims ?? {}) as Record<string, unknown>,
        kid,
        typ,
        ttl,
      });
    });
    // Google service-account exchange (assertion signing + token fetch + cache):
    //   google_oauth({account: kv('ANDROID_SERVICE_ACCOUNT'),
    //                 scope: 'https://www.googleapis.com/auth/androidpublisher'})
    this.runtime.addFunction("google_oauth", (opts: unknown) => {
      if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
        throw new HeaderExpressionError(
          "google_oauth() — pass one object: google_oauth({account, scope[, ttl]})",
        );
      }
      const { account, scope, ttl } = opts as Record<string, unknown>;
      if (typeof account !== "string" || typeof scope !== "string") {
        throw new HeaderExpressionError("google_oauth() — account and scope must be strings");
      }
      if (ttl !== undefined && (typeof ttl !== "number" || !Number.isInteger(ttl))) {
        throw new HeaderExpressionError("google_oauth() — ttl must be an integer (seconds)");
      }
      return googleOAuth({ account, scope, ttl });
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
