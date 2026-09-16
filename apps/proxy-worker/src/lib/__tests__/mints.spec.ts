import { describe, it, expect } from "vitest";
import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";
import { KeyMintStore } from "../mints";

/** Fresh isolated store per test — never the process-wide singleton. */
const freshStore = () => new KeyMintStore({ storage: createStorage({ driver: memoryDriver() }) });

describe("KeyMintStore", () => {
  it("records and lists mints newest-first", async () => {
    const store = freshStore();
    await store.record({
      jti: "t1",
      name: "old",
      scopes: ["proxy:call"],
      iat: 100,
      exp: 100 + 60,
    });
    await store.record({
      jti: "t2",
      name: "new",
      scopes: ["admin"],
      integrations: [{ id: "axiom" }],
      iat: 200,
      exp: 200 + 60,
    });
    const list = await store.list();
    expect(list.map((m) => m.jti)).toEqual(["t2", "t1"]);
    expect(list[0]).toMatchObject({ name: "new", integrations: [{ id: "axiom" }] });
  });

  it("skips corrupt or empty entries", async () => {
    const storage = createStorage({ driver: memoryDriver() });
    const store = new KeyMintStore({ storage });
    await storage.setItem("key:broken", "not-json");
    await storage.setItem("key:empty", "");
    await store.record({ jti: "t3", name: "fine", scopes: ["proxy:call"], iat: 300, exp: 360 });
    const list = await store.list();
    expect(list.map((m) => m.jti)).toEqual(["t3"]);
  });

  it("returns [] when the store read fails", async () => {
    const broken = {
      getKeys: async () => {
        throw new Error("kv down");
      },
    } as never;
    const store = new KeyMintStore({ storage: broken });
    expect(await store.list()).toEqual([]);
  });
});
