/**
 * Platform runtime seam — the only place the worker touches its host.
 *
 * NO `node:` built-ins may be imported from this module: it is also loaded on
 * Workers and in edge test isolates. Entry-only helpers (like loading
 * `.dev.vars`) live in `src/entry/`.
 *
 * Storage and env aren't Cloudflare-specific at the app level:
 *  - `kvStore` returns an unstorage `Storage`; on Workers it wraps the HODOR_KV
 *    KVNamespace binding (one store per binding, cached). Anywhere else it is
 *    a process-wide store — memory by default, or the `fs` driver under
 *    `HODOR_KV_DATA_DIR` (opt into memory explicitly with `HODOR_KV_DRIVER=memory`).
 *  - `runtimeOf` builds a {@link Runtime} from Hono's bindings, falling back
 *    to `process.env` for names the platform didn't inject, so the same app
 *    runs as a Cloudflare Worker or a standalone Node/Bun server.
 *
 * The `fs` driver is imported lazily: tests and Workers must never load
 * `node:fs`-backed glue. Entrypoints are `src/index.ts` (Workers),
 * `src/entry/node.ts`, and `src/entry/bun.ts`.
 * @module
 */
import { createStorage, type Storage } from "unstorage";
import cloudflareKVBindingDriver from "unstorage/drivers/cloudflare-kv-binding";
import memoryDriver from "unstorage/drivers/memory";

export type KeyValueStore = Storage;

const DEFAULT_DATA_DIR = ".data/kv";

/** Structural check for a Cloudflare KVNamespace binding (has get/put/delete). */
function isCloudflareBinding(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { put?: unknown }).put === "function" &&
    typeof (value as { delete?: unknown }).delete === "function"
  );
}

const cfStores = new WeakMap<object, Storage>();
let standalone: Promise<Storage> | null = null;

/** Process-wide store for standalone runtimes (memory or fs, default memory). */
function standaloneStore(): Promise<Storage> {
  standalone ??= (async () => {
    const memory =
      (process.env.HODOR_KV_DRIVER ?? "").toLowerCase() === "memory" ||
      !process.env.HODOR_KV_DATA_DIR;
    if (memory) return createStorage({ driver: memoryDriver() });
    const { default: fsDriver } = await import("unstorage/drivers/fs");
    return createStorage({
      driver: fsDriver({ base: process.env.HODOR_KV_DATA_DIR ?? DEFAULT_DATA_DIR }),
    });
  })();
  return standalone;
}

/**
 * The runtime key-value store. On Workers pass the HODOR_KV binding; elsewhere
 * pass nothing and a process-wide store (memory or `HODOR_KV_DATA_DIR`) is used.
 * The binding-present store is cached per binding (multiple bindings/mocks
 * stay isolated; production shares one store per isolate).
 */
export function kvStore(input: { binding?: unknown }): Promise<KeyValueStore> {
  const { binding } = input;
  if (isCloudflareBinding(binding)) {
    let store = cfStores.get(binding as object);
    if (!store) {
      // One structural cast at the platform boundary, forever after typed.
      store = createStorage({
        driver: cloudflareKVBindingDriver({ binding: binding as KVNamespace }),
      });
      cfStores.set(binding as object, store);
    }
    return Promise.resolve(store);
  }
  return standaloneStore();
}

/** Platform services one worker needs, resolved from Hono's env. */
export interface Runtime {
  storage: KeyValueStore;
  /** Indexable env map (Cloudflare bindings, or injected process env). */
  bindings: Record<string, unknown>;
  /** Read a config value: injected bindings first, then process env. */
  env(name: string): string | undefined;
}

/**
 * Build the runtime from Hono's env object (Cloudflare bindings, or the env
 * map a standalone entry injects — in both cases one structural cast here).
 */
export async function runtimeOf(ctx: { env: unknown }): Promise<Runtime> {
  const bindings = (ctx.env ?? {}) as Record<string, unknown>;
  const storage = await kvStore({ binding: bindings["HODOR_KV"] });
  return {
    storage,
    bindings,
    env: (name: string) => {
      const value = bindings[name];
      if (typeof value === "string") return value;
      return process.env[name];
    },
  };
}

/**
 * A portable `ExecutionContext` for standalone servers: `waitUntil` defers
 * the promise to the background (audit writes, etc.), never blocking the
 * response. On Workers the real execution context is used instead.
 */
export function standaloneExecutionContext(): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => void promise.catch(() => {}),
    passThroughOnException: () => {},
  } as ExecutionContext;
}
