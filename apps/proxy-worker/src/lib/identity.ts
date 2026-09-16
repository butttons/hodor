/**
 * Consumer identity headers — stamped on every proxied request so the upstream
 * can tell *which* minted key called it (the exe.dev `X-Exedev-Source-Vm` /
 * `Token-Ctx` analog).
 *
 * The proxy strips any client-sent copies of these headers (see `STRIPPED` in
 * the proxy route) and re-stamps them itself from the verified JWT payload, so
 * they cannot be forged by the caller. Third-party upstreams simply ignore
 * them; a downstream service you control can log or authorize per consumer.
 *
 *   X-Hodor-Key     — the minted key's `name`
 *   X-Hodor-Key-Id  — the minted key's `jti` (machine-readable correlation)
 *   X-Hodor-Ctx     — the token's optional `ctx` claim, passed verbatim
 *                         (strings as-is, JSON values stringified). Sized for
 *                         the upstream's own per-consumer authz rules.
 *
 * @module
 */

export const KEY_NAME_HEADER = "x-hodor-key";
export const KEY_ID_HEADER = "x-hodor-key-id";
export const CTX_HEADER = "x-hodor-ctx";

/** Header names, lowercase, for the proxy's STRIPPED set. */
export const IDENTITY_HEADERS = [KEY_NAME_HEADER, KEY_ID_HEADER, CTX_HEADER];

/**
 * Build the identity headers from a verified JWT payload.
 *
 * Always stamps `name` + `jti` when present (every minted key carries both);
 * the `ctx` header is emitted only when the token has a `ctx` claim.
 */
export function consumerIdentityHeaders(
  payload: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!payload) return out;
  if (typeof payload.name === "string" && payload.name.length > 0) {
    out[KEY_NAME_HEADER] = payload.name;
  }
  if (typeof payload.jti === "string" && payload.jti.length > 0) {
    out[KEY_ID_HEADER] = payload.jti;
  }
  const ctx = payload.ctx;
  if (ctx !== undefined && ctx !== null) {
    out[CTX_HEADER] = typeof ctx === "string" ? ctx : JSON.stringify(ctx);
  }
  return out;
}
