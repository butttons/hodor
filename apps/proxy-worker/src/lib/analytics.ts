/**
 * Analytics Engine audit logging for proxy traffic.
 *
 * Writes one data point **per request**, on every exit path — including
 * rejections and errors: 401/403 (auth/permission rejected), 404 (unknown
 * integration label), 0 (upstream fetch error), or the upstream HTTP status.
 * Writes are deferred via `waitUntil` (they must not block the response). The
 * positional contract below is fixed — change it everywhere or not at all, so
 * SQL stays stable.
 *
 * Status conventions: doubles[0]/blobs[5] carry the HTTP status of the
 * terminal outcome; `0` means the upstream fetch itself failed (DNS/conn/
 * timeout). `itemId`/`keyJti` are empty strings when unknown (e.g. unauthenticated
 * requests, where only the host label is known).
 *
 * Data point layout:
 *   indexes[0] = `${itemId}:${keyJti}`   — WHERE filter: integration + key
 *   doubles[0] = upstream HTTP status
 *   doubles[1] = request duration (ms)
 *   doubles[2] = method weight (1 = read, 2 = write) for cheap reads/writes
 *   blobs[0]   = integration/registry item id
 *   blobs[1]   = minted key jti
 *   blobs[2]   = minted key name (or "")
 *   blobs[3]   = HTTP method
 *   blobs[4]   = request path
 *   blobs[5]   = upstream HTTP status
 *   blobs[6]   = client IP (`cf-connecting-ip`, else first `x-forwarded-for`)
 *   blobs[7]   = user agent (capped)
 *
 * New fields are appended, never inserted — existing blob positions stay stable.
 * @module
 */

export interface ProxyAuditEvent {
  itemId: string;
  keyJti: string;
  keyName: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip?: string;
  userAgent?: string;
}

/**
 * Control-surface audit logging (`hodor_audit_log` dataset). One data point
 * per control-surface **mutation** (non-GET on `/_/keys` + `/_/admin/*`),
 * written the same deferred way. Reads are excluded (volume); use the mint
 * ledger + registry state for those.
 *
 * Data point layout:
 *   indexes[0] = key jti (actor)  — WHERE filter: who did it
 *   doubles[0] = terminal HTTP status
 *   blobs[0]   = request path (includes ids, e.g. revoked key jti)
 *   blobs[1]   = HTTP method
 *   blobs[2]   = minted key name (actor)
 *   blobs[3]   = detail (minted key name for mints, else "")
 *   blobs[4]   = terminal HTTP status
 *   blobs[5]   = client IP (`cf-connecting-ip`, else first `x-forwarded-for`)
 *   blobs[6]   = user agent (capped)
 *
 * New fields are appended, never inserted — existing blob positions stay stable.
 */

export interface AdminAuditEvent {
  keyJti: string;
  keyName: string;
  method: string;
  path: string;
  status: number;
  detail?: string;
  ip?: string;
  userAgent?: string;
}

/** Persist a control-surface audit point. Same no-op contract as above. */
export async function auditAdminCall(input: {
  analytics: AnalyticsEngineDataset | undefined;
  event: AdminAuditEvent;
}): Promise<void> {
  const { analytics, event } = input;
  if (!analytics) return;
  analytics.writeDataPoint({
    indexes: [event.keyJti],
    doubles: [event.status],
    blobs: [
      event.path,
      event.method,
      event.keyName,
      event.detail ?? "",
      String(event.status),
      event.ip ?? "",
      event.userAgent ?? "",
    ],
  });
}

/**
 * Request attribution for audit points. Keys carry no identity of their own,
 * so every audit row stamps where the call came from: the edge-provided
 * client IP plus the caller user agent (both capped, empty when absent —
 * e.g. unit tests and non-Cloudflare runtimes).
 */
export function requestMeta(req: { header: (name: string) => string | undefined }): {
  ip: string;
  userAgent: string;
} {
  const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return {
    ip: (req.header("cf-connecting-ip") ?? forwarded).slice(0, 64),
    userAgent: (req.header("user-agent") ?? "").slice(0, 512),
  };
}

/**
 * Deferred write that survives contexts without an ExecutionContext (unit
 * tests): falls back to a floating promise instead of throwing.
 */
export function defer(
  ctx: { executionCtx?: { waitUntil?: (promise: Promise<unknown>) => void } },
  promise: Promise<unknown>,
): void {
  try {
    ctx.executionCtx?.waitUntil?.(promise);
  } catch {
    promise.catch(() => {});
  }
}

/** Read-like methods vs write-like methods, for the doubles[2] "weight". */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Persist an audit data point for a proxied request. No-op only when no
 * Analytics Engine binding is configured (e.g. the standalone Node/Bun
 * runtime). Audit logging is always done — there is no toggle.
 */
export async function auditProxyCall(input: {
  analytics: AnalyticsEngineDataset | undefined;
  event: ProxyAuditEvent;
}): Promise<void> {
  const { analytics, event } = input;
  if (!analytics) return;
  const weight = WRITE_METHODS.has(event.method) ? 2 : 1;
  analytics.writeDataPoint({
    indexes: [`${event.itemId}:${event.keyJti}`],
    doubles: [event.status, event.durationMs, weight],
    blobs: [
      event.itemId,
      event.keyJti,
      event.keyName,
      event.method,
      event.path,
      String(event.status),
      event.ip ?? "",
      event.userAgent ?? "",
    ],
  });
}
