/**
 * Standalone Node.js entrypoint — `pnpm dev:node` / `pnpm start:node`.
 *
 * Same app as the Cloudflare Worker (`src/index.ts`), served with
 * `@hono/node-server`. Env comes from `.dev.vars` (local) or the real
 * environment (production): HODOR_JWT_SECRET, HODOR_ENCRYPTION_KEY, HODOR_CATALOG_RAW_BASE,
 * HODOR_KV_DRIVER / HODOR_KV_DATA_DIR for the unstorage backend.
 * Analytics Engine is a no-op here (no binding); audit writes are deferred
 * and dropped.
 * @module
 */
import { serve } from "@hono/node-server";
import app from "../index";
import { standaloneExecutionContext } from "../lib/runtime";
import { loadDevVars } from "./devvars";

loadDevVars();

const { PORT = "3000", HOST = "0.0.0.0" } = process.env;

serve({
  // env map: process.env doubles as bindings (HODOR_JWT_SECRET, HODOR_CATALOG_RAW_BASE,
  // …); HODOR_KV is absent here, so runtime.ts uses the standalone store.
  fetch: (request: Request) =>
    app.fetch(request, { ...process.env } as unknown as Env, standaloneExecutionContext()),
  port: Number(PORT),
  hostname: HOST,
});

console.log(`hodor listening on http://${HOST}:${PORT}`);
