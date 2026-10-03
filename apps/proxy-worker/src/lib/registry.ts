/**
 * Registry store — two sources, one read interface.
 *
 * Compiled mode (deployed workers): items are baked into the bundle by
 * `scripts/snapshot-registry.mjs` (`src/generated/registry.json`, per deploy
 * copy). Reads are pure memory lookups — zero KV on the proxy hot path.
 * Live mode (local dev, tests, placeholder snapshot): reads fall through to
 * `HODOR_KV` (`r:<id>` items + the `meta:registry` manifest). Admin writes
 * always go to KV; in compiled mode they are a draft until the next snapshot
 * + redeploy (the admin surface reports `redeployRequired` + drift).
 *
 * Keyspaces (namespaced, no collisions):
 *   `r:<id>`        — registry items (id regex forbids colon, so never clash)
 *   `meta:registry` — the registry manifest
 *   `s:<ns>:<NAME>` — encrypted secrets
 *
 * Values are stored/read as native JSON through the unstorage layer (it
 * serializes for the Cloudflare KV driver and deserializes on read).
 * Safe to compile: items hold JEXL *references* (`secret('NAME')`,
 * `variable('NAME')`) plus non-secret `identifiers`, never credential values.
 * @module
 */
import { AppHTTPException, ErrorCodes } from "./errors";
import type { KeyValueStore } from "./runtime";
import { proxyItem as proxyItemSchema, type ProxyItem } from "./schema";
import { REGISTRY_SNAPSHOT } from "./snapshot";

const KEY_PREFIX = "r:";
const MANIFEST_KEY = "meta:registry";

/** Snapshot mode: which backing store serves registry reads. */
export type RegistryMode = "snapshot" | "kv";

export interface RegistryStoreInput {
  storage: KeyValueStore;
  /** Compiled items for this bundle; defaults to the bundled snapshot. */
  snapshotItems?: Record<string, ProxyItem>;
  /** Snapshot stamp for `/_/admin/info`; defaults to the bundled stamp. */
  snapshotMeta?: { at: string; apex: string; count: number } | null;
}

function isStore(input: KeyValueStore | RegistryStoreInput): input is KeyValueStore {
  return typeof (input as KeyValueStore).getItem === "function";
}

export class RegistryStore {
  /** Compiled items baked into the bundle (empty object = live-KV mode). */
  readonly compiled: Record<string, ProxyItem>;
  /** Snapshot stamp for `/_/admin/info` (null = no snapshot compiled). */
  readonly snapshotMeta: { at: string; apex: string; count: number } | null;

  constructor(input: KeyValueStore | RegistryStoreInput) {
    if (isStore(input)) {
      this.store = input;
      this.compiled = REGISTRY_SNAPSHOT.items;
      this.snapshotMeta = REGISTRY_SNAPSHOT.meta;
    } else {
      this.store = input.storage;
      this.compiled = input.snapshotItems ?? REGISTRY_SNAPSHOT.items;
      this.snapshotMeta =
        input.snapshotMeta === undefined ? REGISTRY_SNAPSHOT.meta : input.snapshotMeta;
    }
  }

  private readonly store: KeyValueStore;

  /** True when this bundle carries a compiled snapshot (proxy serves memory). */
  get isCompiled(): boolean {
    return Object.keys(this.compiled).length > 0;
  }

  /** Which backing store serves this read (`"snapshot"` or `"kv"`). */
  get mode(): RegistryMode {
    return this.isCompiled ? "snapshot" : "kv";
  }

  /** Load a single item; throws 404 if absent or corrupt. */
  async getOne(id: string): Promise<ProxyItem> {
    if (this.isCompiled) {
      const item = this.compiled[id];
      if (!item) {
        throw new AppHTTPException({
          message: `Registry item "${id}" not found`,
          code: ErrorCodes.NOT_FOUND,
          status: 404,
        });
      }
      return item;
    }
    const parsed = await this.readValid(id);
    if (!parsed) {
      throw new AppHTTPException({
        message: `Registry item "${id}" not found`,
        code: ErrorCodes.NOT_FOUND,
        status: 404,
      });
    }
    return parsed;
  }

  /**
   * Load every item. Compiled mode returns the snapshot from memory (zero
   * KV reads); live mode reads via the manifest (one read + N reads, no
   * listing) with a one-time key-listing bootstrap when no manifest exists.
   */
  async getAll(): Promise<Record<string, ProxyItem>> {
    if (this.isCompiled) return { ...this.compiled };
    const ids = (await this.store.getItem<string[]>(MANIFEST_KEY)) ?? null;

    if (!ids) {
      // Bootstrap: nothing indexed yet — list once and persist a manifest.
      const keys = await this.store.getKeys(KEY_PREFIX);
      const items: Record<string, ProxyItem> = {};
      for (const name of keys) {
        const id = name.slice(KEY_PREFIX.length);
        const value = await this.readValid(id);
        if (value) items[id] = value;
      }
      if (Object.keys(items).length > 0) {
        await this.store.setItem(MANIFEST_KEY, Object.keys(items));
      }
      return items;
    }

    const items: Record<string, ProxyItem> = {};
    for (const id of ids) {
      const value = await this.readValid(id);
      if (value) items[id] = value;
    }
    return items;
  }

  private async readValid(id: string): Promise<ProxyItem | null> {
    const raw = await this.store.getItem<unknown>(this.key(id)).catch(() => null);
    if (raw === null || raw === undefined) return null;
    try {
      const parsed = proxyItemSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      console.error(`Registry item "${id}" failed validation; skipped`);
    } catch {
      console.error(`Registry item "${id}" unreadable; skipped`);
    }
    return null;
  }

  key(id: string): string {
    return `${KEY_PREFIX}${id}`;
  }

  /**
   * The live KV draft — reads that bypass the snapshot. The admin surface
   * uses this for drift detection (`/_/admin/info`) and the post-write
   * response (`redeployRequired` until the next snapshot + redeploy).
   */
  async getDraft(): Promise<Record<string, ProxyItem>> {
    const ids = (await this.store.getItem<string[]>(MANIFEST_KEY)) ?? null;
    if (!ids) {
      const keys = await this.store.getKeys(KEY_PREFIX);
      const items: Record<string, ProxyItem> = {};
      for (const name of keys) {
        const value = await this.readValid(name.slice(KEY_PREFIX.length));
        if (value) items[value.id] = value;
      }
      return items;
    }
    const items: Record<string, ProxyItem> = {};
    for (const id of ids) {
      const value = await this.readValid(id);
      if (value) items[id] = value;
    }
    return items;
  }

  /** Validate + write one item and register it in the manifest. */
  async putItem(input: { id: string; item: Record<string, unknown> }): Promise<ProxyItem> {
    const parsed = proxyItemSchema.safeParse({ ...input.item, id: input.id });
    if (!parsed.success) {
      throw new AppHTTPException({
        message: `Invalid registry item: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        code: ErrorCodes.VALIDATION_FAILED,
        status: 400,
      });
    }
    await this.store.setItem(this.key(input.id), parsed.data);
    await this.manifestAdd(input.id);
    return parsed.data;
  }

  /** Replace the entire registry: write items, drop stale ones, rebuild the manifest. */
  async putAll(items: Record<string, Record<string, unknown>>): Promise<void> {
    const desired = new Set<string>();
    for (const [id, value] of Object.entries(items)) {
      await this.putItem({ id, item: value });
      desired.add(id);
    }
    // Drop ids that no longer exist, using the old manifest (no listing).
    const oldIds = (await this.store.getItem<string[]>(MANIFEST_KEY)) ?? [];
    for (const id of oldIds) {
      if (!desired.has(id)) await this.store.removeItem(this.key(id));
    }
    await this.store.setItem(MANIFEST_KEY, [...desired]);
  }

  /** Delete one item and drop it from the manifest; no-op if absent. */
  async deleteItem(id: string): Promise<void> {
    await this.store.removeItem(this.key(id));
    await this.manifestRemove(id);
  }

  private async manifestAdd(id: string): Promise<void> {
    const current = (await this.store.getItem<string[]>(MANIFEST_KEY)) ?? [];
    if (!current.includes(id)) {
      current.push(id);
      await this.store.setItem(MANIFEST_KEY, current);
    }
  }

  private async manifestRemove(id: string): Promise<void> {
    const current = (await this.store.getItem<string[]>(MANIFEST_KEY)) ?? [];
    const next = current.filter((entry) => entry !== id);
    if (next.length !== current.length) {
      await this.store.setItem(MANIFEST_KEY, next);
    }
  }
}
