/**
 * Per-isolate dependency wiring: secret store, registry store, and a secret
 * resolver for the header engine. Built once per storage and cached.
 * @module
 */
import type { Context } from "hono";
import type { AppEnv } from "./lib/auth";
import { HeaderExpressionEngine, HeaderExpressionError, type SecretResolver } from "./lib/engine";
import { getMintStore, KeyMintStore } from "./lib/mints";
import { RegistryStore } from "./lib/registry";
import { getRevocationStore, RevocationStore } from "./lib/revocation";
import { importEncryptionKey, SecretStore } from "./lib/secrets";
import { runtimeOf, type KeyValueStore, type Runtime } from "./lib/runtime";

export interface Deps {
  secrets: SecretStore;
  registry: RegistryStore;
  revocations: RevocationStore;
  /** Mint ledger: metadata of every key ever minted (token-free). */
  mints: KeyMintStore;
  /** Resolver bound to the store, translating failures to HeaderExpressionError. */
  resolver: SecretResolver;
  /** Builds a header engine bound to {@link Deps.resolver}. */
  engine: () => HeaderExpressionEngine;
}

const depsByStorage = new WeakMap<KeyValueStore, Promise<Deps>>();

/** Lazily build (and cache per storage) the dependency graph. */
export async function getDeps(ctx: Context<AppEnv>): Promise<Deps> {
  const runtime = await runtimeOf(ctx);
  let deps = depsByStorage.get(runtime.storage);
  if (!deps) {
    deps = buildDeps(runtime);
    depsByStorage.set(runtime.storage, deps);
  }
  return deps;
}

async function buildDeps(runtime: Runtime): Promise<Deps> {
  const encryptionKey = runtime.env("HODOR_ENCRYPTION_KEY");
  if (!encryptionKey) throw new Error("HODOR_ENCRYPTION_KEY is not configured");
  const key = await importEncryptionKey(encryptionKey);
  const secrets = new SecretStore({ storage: runtime.storage, cryptoKey: key });
  const registry = new RegistryStore(runtime.storage);
  const revocations = getRevocationStore(runtime.storage);
  const mints = getMintStore(runtime.storage);

  const resolver: SecretResolver = async (name, namespace) => {
    try {
      return await secrets.get({
        namespace: namespace ?? SecretStore.defaultNamespace(),
        name,
      });
    } catch (cause) {
      if (cause instanceof HeaderExpressionError) throw cause;
      throw new HeaderExpressionError(
        `Unable to resolve secret ${name}: ${(cause as Error).message}`,
      );
    }
  };

  return {
    secrets,
    registry,
    revocations,
    mints,
    resolver,
    // The engine indexes the runtime env record (bindings / process env).
    engine: () =>
      new HeaderExpressionEngine({
        kv: resolver,
        env: runtime.bindings as unknown as Env,
      }),
  };
}
