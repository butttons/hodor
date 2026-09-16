/**
 * Standalone Bun entrypoint — `pnpm dev:bun` / `pnpm start:bun`.
 *
 * Same app as the Cloudflare Worker (`src/index.ts`), served with Bun's own
 * HTTP server. Env comes from `.dev.vars` (local) or the real environment:
 * HODOR_JWT_SECRET, HODOR_ENCRYPTION_KEY, HODOR_CATALOG_RAW_BASE,
 * HODOR_KV_DRIVER / HODOR_KV_DATA_DIR for the unstorage backend. Analytics Engine is a
 * no-op here (no binding); audit writes are deferred and dropped.
 * @module
 */
import app from "../index";
import { standaloneExecutionContext } from "../lib/runtime";
import { loadDevVars } from "./devvars";

loadDevVars();

const { PORT = "3000", HOST = "0.0.0.0" } = process.env;

// Minimal Bun surface (no @types/bun dependency; the worker bundles must stay
// typecheckable without Bun's globals).
declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch: (request: Request) => Response | Promise<Response>;
  }): void;
};

Bun.serve({
  port: Number(PORT),
  hostname: HOST,
  fetch: (request: Request) =>
    app.fetch(request, { ...process.env } as unknown as Env, standaloneExecutionContext()),
});

console.log(`hodor listening on http://${HOST}:${PORT}`);
