import { describe, it, expect } from "vitest";
import { RevocationStore } from "../revocation";
import { kvStore } from "../runtime";

/** A minimal KVNamespace mock storing values in-memory. */
function mockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async ({ prefix }: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    }),
  } as unknown as KVNamespace;
}

describe("RevocationStore", () => {
  it("is empty by default", async () => {
    const storage = await kvStore({ binding: mockKV() });
    const store = new RevocationStore({ storage });
    expect(await store.isRevoked("jti-1")).toBe(false);
    expect(await store.revoked()).toEqual([]);
  });

  it("revokes a jti (immediate in the same isolate)", async () => {
    const kv = mockKV();
    const storage = await kvStore({ binding: kv });
    const store = new RevocationStore({ storage });
    await store.revoke("jti-1");
    expect(await store.isRevoked("jti-1")).toBe(true);
    expect(await store.revoked()).toEqual(["jti-1"]);
  });

  it("persists revoked jtis to the store so other isolates pick them up", async () => {
    const kv = mockKV();
    const storage = await kvStore({ binding: kv });
    const store = new RevocationStore({ storage });
    await store.revoke("jti-9");
    // A fresh store (new isolate) reads from the same storage and sees it.
    const other = new RevocationStore({ storage });
    expect(await other.isRevoked("jti-9")).toBe(true);
  });

  it("reads a per-key entry without the legacy array", async () => {
    const storage = await kvStore({ binding: mockKV() });
    await storage.setItem("revoked:jti-9", "1");
    const store = new RevocationStore({ storage });
    expect(await store.isRevoked("jti-9")).toBe(true);
    expect(await store.isRevoked("jti-other")).toBe(false);
  });

  it("revoking the same jti twice stays idempotent", async () => {
    const storage = await kvStore({ binding: mockKV() });
    const store = new RevocationStore({ storage });
    await store.revoke("k");
    await store.revoke("k");
    expect(await store.revoked()).toEqual(["k"]);
  });
});
