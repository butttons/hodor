/**
 * Registry store on the key-value store — one key per item (`r:<id>` →
 * proxyItem) plus a single **manifest** in its own namespace
 * (`meta:registry` → list of ids) so full reads are manifest-driven with no
 * key listing on the hot path. A list is used only as a one-time bootstrap
 * when no manifest exists yet.
 *
 * Keyspaces (namespaced, no collisions):
 *   `r:<id>`        — registry items (id regex forbids colon, so never clash)
 *   `meta:registry` — the registry manifest
 *   `s:<ns>:<NAME>` — encrypted secrets
 *
 * Values are stored/read as native JSON through the unstorage layer (it
 * serializes for the Cloudflare KV driver and deserializes on read).
 * @module
 */
import { AppHTTPException, ErrorCodes } from "./errors";
import type { KeyValueStore } from "./runtime";
import { proxyItem as proxyItemSchema, type ProxyItem } from "./schema";

const KEY_PREFIX = "r:";
const MANIFEST_KEY = "meta:registry";

export class RegistryStore {
  constructor(private readonly store: KeyValueStore) {}

  key(id: string): string {
    return `${KEY_PREFIX}${id}`;
  }

  /** Load a single item; throws 404 if absent or corrupt. */
  async getOne(id: string): Promise<ProxyItem> {
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
   * Load every item into a keyed registry via the manifest (one read + N
   * reads, no listing). Falls back to a one-time key listing when no
   * manifest exists.
   */
  async getAll(): Promise<Record<string, ProxyItem>> {
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
