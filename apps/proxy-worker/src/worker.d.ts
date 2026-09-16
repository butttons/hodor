/**
 * Secret bindings typed for the app code.
 *
 * Secrets (`HODOR_ENCRYPTION_KEY`, `HODOR_JWT_SECRET`) are injected at runtime
 * via `wrangler secret put` (production) or `.dev.vars` (local). They are NOT
 * declared in `wrangler.jsonc` `vars`, so `wrangler types` omits them from the
 * generated `worker-configuration.d.ts` — this ambient file merges them into
 * the global `Env` interface so routes that mint keys / rekey type-check.
 */
interface Env {
  HODOR_ENCRYPTION_KEY: string;
  HODOR_JWT_SECRET: string;
}
