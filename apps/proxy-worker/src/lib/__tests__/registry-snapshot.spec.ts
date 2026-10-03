import { describe, it, expect } from "vitest";
import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";

import { RegistryStore } from "@/lib/registry";

const ITEM = {
  id: "test",
  url: { protocol: "https", host: "httpbin.org" },
  headers: { "x-item": "'static-value'" },
  meta: { label: "Test service", description: "A test upstream" },
};

const store = () => createStorage({ driver: memoryDriver() });

describe("RegistryStore snapshot mode", () => {
  it("serves compiled items without touching KV", async () => {
    const registry = new RegistryStore({
      storage: store(),
      snapshotItems: { test: ITEM as never },
      snapshotMeta: { at: "2026-10-03T00:00:00.000Z", apex: "https://example.com", count: 1 },
    });
    expect(registry.mode).toBe("snapshot");
    expect(registry.isCompiled).toBe(true);
    expect(await registry.getOne("test")).toEqual(ITEM);
    expect(await registry.getAll()).toEqual({ test: ITEM });
    await expect(registry.getOne("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("reports its snapshot stamp", () => {
    const registry = new RegistryStore({
      storage: store(),
      snapshotItems: { test: ITEM as never },
      snapshotMeta: { at: "2026-10-03T00:00:00.000Z", apex: "https://example.com", count: 1 },
    });
    expect(registry.snapshotMeta).toMatchObject({ apex: "https://example.com", count: 1 });
  });

  it("falls back to KV with an empty snapshot (placeholder)", async () => {
    const storage = store();
    await storage.setItem("r:test", ITEM);
    await storage.setItem("meta:registry", ["test"]);
    const registry = new RegistryStore({ storage, snapshotItems: {}, snapshotMeta: null });
    expect(registry.mode).toBe("kv");
    expect(await registry.getOne("test")).toEqual(ITEM);
    expect(await registry.getDraft()).toEqual({ test: ITEM });
  });

  it("reads the KV draft even when compiled", async () => {
    const storage = store();
    await storage.setItem("r:extra", { ...ITEM, id: "extra" });
    await storage.setItem("meta:registry", ["extra"]);
    const registry = new RegistryStore({
      storage,
      snapshotItems: { test: ITEM as never },
      snapshotMeta: null,
    });
    expect(Object.keys(await registry.getAll())).toEqual(["test"]);
    expect(Object.keys(await registry.getDraft())).toEqual(["extra"]);
  });
});
