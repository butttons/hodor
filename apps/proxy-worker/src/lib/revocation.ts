/**
 * API-key revocation via per-key denylist entries.
 *
 * JWTs can't be un-issued, so revocation is a denylist. Each revoked jti gets
 * its own key (`revoked:<jti>` → `"1"`); the hot path reads that one key
 * (cached per-isolate, short TTL). No shared registry, nothing to prune.
 * @module
 */
import type { KeyValueStore } from "./runtime";

const revokedKey = (jti: string): string => `revoked:${jti}`;
const DEFAULT_TTL_MS = 30_000;

export class RevocationStore {
  private cache = new Map<string, { value: boolean; expiresAt: number }>();

  constructor(input: { storage: KeyValueStore; ttlMs?: number }) {
    this.store = input.storage;
    this.ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  }

  private readonly store: KeyValueStore;
  private readonly ttlMs: number;

  /** Whether a key's jti has been revoked: one key lookup, cached. */
  async isRevoked(jti: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.cache.get(jti);
    if (hit && hit.expiresAt > now) return hit.value;
    let value = false;
    try {
      value = (await this.store.getItem(revokedKey(jti))) != null;
    } catch {
      value = false;
    }
    this.cache.set(jti, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  /** Revoke a key jti: one entry. */
  async revoke(jti: string): Promise<void> {
    this.cache.set(jti, { value: true, expiresAt: Date.now() + this.ttlMs });
    await this.store.setItem(revokedKey(jti), "1");
  }

  /** All currently-revoked jtis (used for admin listing). */
  async revoked(): Promise<string[]> {
    try {
      const keys = await this.store.getKeys("revoked:");
      return keys.map((key) => key.slice("revoked:".length)).filter((jti) => jti.length > 0);
    } catch {
      return [];
    }
  }
}

/**
 * Per-isolate cached store, keyed by the storage so auth + admin share one
 * instance (a revoke is visible immediately within the same isolate). Tests
 * pass distinct stores, so each is isolated.
 */
const stores = new WeakMap<KeyValueStore, RevocationStore>();
export function getRevocationStore(store: KeyValueStore): RevocationStore {
  let revocation = stores.get(store);
  if (!revocation) {
    revocation = new RevocationStore({ storage: store });
    stores.set(store, revocation);
  }
  return revocation;
}
