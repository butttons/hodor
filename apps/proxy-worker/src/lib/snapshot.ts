/**
 * Compiled registry snapshot — the registry baked into the worker bundle.
 *
 * `src/generated/registry.json` is written per deploy copy from the live
 * `GET /_/admin/registry/snapshot` (one curl, saved straight to that path).
 * Items are re-validated here at startup; corrupt entries are skipped with an
 * error log, never a boot failure. The committed placeholder
 * (`{ snapshot: null, items: {} }`) means live-KV mode — local dev and tests.
 *
 * Safe to bundle: registry items hold JEXL *references* (`secret('NAME')`,
 * `variable('NAME')`) plus non-secret identifiers, never credential values.
 * @module
 */
import raw from "@/generated/registry.json";
import { proxyItem, type ProxyItem } from "./schema";

/** Snapshot stamp written by the snapshot script. */
export interface RegistrySnapshotMeta {
  at: string;
  apex: string;
  count: number;
}

/** A validated snapshot: stamp plus the deployed item map. */
export interface RegistrySnapshot {
  meta: RegistrySnapshotMeta | null;
  items: Record<string, ProxyItem>;
}

function isMeta(value: unknown): value is RegistrySnapshotMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.at === "string" && typeof meta.apex === "string" && typeof meta.count === "number"
  );
}

function loadSnapshot(): RegistrySnapshot {
  const fallback: RegistrySnapshot = { meta: null, items: {} };
  try {
    const data = raw as unknown as { snapshot?: unknown; items?: unknown };
    const meta = isMeta(data.snapshot) ? data.snapshot : null;
    const items: Record<string, ProxyItem> = {};
    if (data.items && typeof data.items === "object") {
      for (const [id, value] of Object.entries(data.items as Record<string, unknown>)) {
        const parsed = proxyItem.safeParse(value);
        if (parsed.success) items[parsed.data.id] = parsed.data;
        else console.error(`Snapshot registry item "${id}" invalid; skipped`);
      }
    }
    return { meta, items };
  } catch {
    return fallback;
  }
}

/** The compiled snapshot for this bundle (placeholder → empty, i.e. KV mode). */
export const REGISTRY_SNAPSHOT: RegistrySnapshot = loadSnapshot();
