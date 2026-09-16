/**
 * API-key mint ledger on the store.
 *
 * Minted keys are JWTs — stateless by design (verify is signature-only). This
 * ledger records the *metadata* of every mint (never the token itself) so
 * admins can list who holds keys, with what scopes/restrictions, and when they
 * expire. Records live under the `key:` prefix, **one per key name**
 * (`key:<name>` holds the latest mint for that name) — name uniqueness is
 * structural, not a laggy list scan. `.list` uses the store's
 * `getKeys(prefix)` (KV `.list` on Workers, dir scan in standalone).
 *
 * Recording is best-effort at the call site: a failed KV write must never
 * fail a mint, and never leaks token material (only claims, token-free).
 * @module
 */
import type { KeyValueStore } from "./runtime";

const PREFIX = "key:";
/** Safety cap — the KV driver lists ~1000 keys; never return more than this. */
const MAX_KEYS = 500;

/** Per-item access rule metadata, mirroring the JWT claim. */
export interface AccessRuleRecord {
  methods?: string[];
  paths?: string[];
}

/** Per-mint metadata, mirroring the JWT payload minus the signature. */
export interface MintRecord {
  jti: string;
  name: string;
  scopes: string[];
  integrations?: { id: string; only?: AccessRuleRecord; except?: AccessRuleRecord }[];
  only?: AccessRuleRecord;
  except?: AccessRuleRecord;
  ctx?: unknown;
  iat: number;
  exp: number;
}

export class KeyMintStore {
  private readonly store: KeyValueStore;

  constructor(input: { storage: KeyValueStore }) {
    this.store = input.storage;
  }

  /** Persist a mint record. Never throws to the caller (best-effort). */
  async record(entry: MintRecord): Promise<void> {
    try {
      // Unstorage auto-(de)serializes: store the object, read the object back.
      await this.store.setItem(`${PREFIX}${entry.name}`, entry);
    } catch {
      // A mint must succeed even if the ledger write fails — the key is
      // already valid by signature; only the record is missing.
    }
  }

  /** Latest record for a name, or undefined. Single read — no list scan. */
  async get(name: string): Promise<MintRecord | undefined> {
    try {
      const raw = await this.store.getItem<unknown>(`${PREFIX}${name}`);
      if (!raw || typeof raw !== "object") return undefined;
      const entry = raw as MintRecord;
      return entry.jti ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * All recorded mints, newest first. A store-read failure degrades to an
   * empty list rather than failing the admin surface.
   */
  async list(): Promise<MintRecord[]> {
    try {
      const keys = await this.store.getKeys(PREFIX);
      const entries = await Promise.all(
        keys.slice(-MAX_KEYS).map(async (key) => {
          try {
            const raw = await this.store.getItem<unknown>(key);
            if (!raw || typeof raw !== "object") return undefined;
            const entry = raw as MintRecord;
            return entry.jti ? entry : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      return entries
        .filter((entry): entry is MintRecord => entry !== undefined)
        .sort((a, b) => b.iat - a.iat);
    } catch {
      return [];
    }
  }
}

/**
 * Per-isolate cached store, keyed by the storage — one instance per store so
 * mints recorded and listed in the same isolate share state and tests stay
 * isolated per store.
 */
const stores = new WeakMap<KeyValueStore, KeyMintStore>();
export function getMintStore(store: KeyValueStore): KeyMintStore {
  let mints = stores.get(store);
  if (!mints) {
    mints = new KeyMintStore({ storage: store });
    stores.set(store, mints);
  }
  return mints;
}
