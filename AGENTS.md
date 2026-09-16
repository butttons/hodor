# Hodor (Cloudflare Workers monorepo)

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated.
Always retrieve current documentation before any Workers, KV, R2, D1, Durable
Objects, Queues, Vectorize, AI, or Agents SDK task.

## The project

Hodor is a self-hosted **token-injecting HTTP reverse proxy**: configure an
API integration once, get a stable subdomain that injects your credentials
automatically. Two deployable apps in a pnpm + turbo workspace:

| path                | package               | what                                            |
| ------------------- | --------------------- | ----------------------------------------------- |
| `apps/proxy-worker` | `@hodor/proxy-worker` | the deployed proxy (Cloudflare Worker)          |
| `apps/docs-worker`  | `@hodor/docs-worker`  | docs site (static assets worker) on `hodor.ing` |

Routing: the proxy owns the `*.hodor.ing` wildcard **route** (first level,
covered by Universal SSL); the docs own the `hodor.ing` apex **custom domain**.

## Deployment sync (deployed copies)

Each deployment is a **copy** of `apps/proxy-worker` kept next to this repo
(e.g. `../my-proxy/`). The code is written/edited **here in hodor first**,
then synced over and deployed from the copy. The only files that intentionally
differ in a copy are `wrangler.jsonc` and `package.json` (plus untracked
`.env` / `.dev.vars`).

Sync command (from repo root):

```bash
rsync -a --delete \
  --exclude node_modules --exclude .turbo --exclude .wrangler --exclude dist \
  --exclude package.json --exclude wrangler.jsonc \
  --exclude .env --exclude .dev.vars --exclude '*.log' \
  apps/proxy-worker/ ../my-proxy/
```

Then `cd ../my-proxy && npx wrangler deploy`.

## Hodor conventions

- Bindings and env vars use the `HODOR_` prefix, **including the two secrets**
  `HODOR_ENCRYPTION_KEY` (base64 of 32 bytes) and `HODOR_JWT_SECRET` (hex 32)
  set via `wrangler secret put` — see `.dev.vars.example` for formats.
- Identity headers are `X-Hodor-Key` / `-Key-Id` / `-Ctx`; hodor JWTs travel
  in **`X-Authorization`** (plain `Authorization` is the fallback, and is the
  header the proxy injects upstream — it is never forwarded).
- Keys are minted knowledge-based at `POST /_/keys` with
  `body.secret === HODOR_JWT_SECRET` — the first admin key can be created
  before any token exists.
- `catalog/*.json` holds the integration templates that the proxy serves;
  `HODOR_CATALOG_RAW_BASE` points at the raw GitHub source (the repo must be
  **public** or catalog fetches 404 at runtime).
- Bindings: `HODOR_KV` KV namespace (encrypted secrets), `HODOR_ANALYTICS`
  analytics engine dataset `hodor_traffic`, plus any `secrets_store_secrets`
  (Cloudflare Secrets Store) entries added per deployment.
- Header templates are JEXL: `kv('NAME')` (encrypted store),
  `secret('NAME')` (plain worker secret binding), `secret_store('NAME')`
  (Secrets Store binding via `env.NAME.get()`), `process_env('NAME')` (host
  `process.env`, standalone Node/Bun only); reserved helpers can't be
  shadowed (see `src/lib/engine.ts`). Registry items may carry
  `identifiers` — non-secret consumer facts (project/zone IDs, datasets,
  region) surfaced verbatim in `/_/reflection` (see `src/lib/schema.ts`).
- The same proxy app also runs as a plain Node/Bun server (no worker runtime,
  KV, or Analytics) — see `apps/proxy-worker/README.md` §Self-host. That
  README is the authority on deploy prerequisites (KV namespace, wildcard DNS).
- **Routing/DNS**: wildcard (`*.domain`) is a worker **route** and needs a
  manual proxied DNS record `A  * → 192.0.2.0` (dummy RFC-5737 address —
  routes don't create DNS); apex/single host is a **custom domain**
  (auto-provisions DNS + cert). First-level wildcards ride Universal SSL.
- **The control surface lives under `/_` and is main/apex-host only**: `/_/keys`, `/_/admin/*`, `/_/reflection`.
  Subdomains are pure forwarders — every path, including `/_/...`, goes through the proxy to the registry
  target. The apex host is `new URL(env.HODOR_APP_URL).host`; requests to any other host on control paths
  are re-dispatched into the proxy pipeline (`forwarder` in `src/index.ts`, shares the app's error envelope).
  On the apex, `/_/admin/registry/:id` GET is NOT an admin route — it falls through to the proxy handler
  (needs `proxy:call`); the admin list route is `GET /_/admin/registry`.
- Stack: Hono, zod, vitest (plain node env for tests), oxlint/oxfmt, turbo.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/`
page. eg. `/workers/platform/limits`

## Commands

From the repo root (turbo runs each in every app):

| Command                               | Purpose                                            |
| ------------------------------------- | -------------------------------------------------- |
| `pnpm install`                        | Install (packageManager: pnpm@11.8)                |
| `pnpm dev`                            | All apps in dev mode (`wrangler dev`)              |
| `pnpm type-check`                     | `tsc --noEmit` everywhere                          |
| `pnpm test`                           | Unit tests (vitest)                                |
| `pnpm build`                          | Standalone node/bun bundles (proxy)                |
| `pnpm cf-typegen`                     | Regenerate worker binding types                    |
| `pnpm version:sync`                   | Stamp workers + `src/version.ts` from root version |
| `pnpm deploy`                         | Deploy all workers                                 |
| `pnpm --filter @hodor/proxy-worker …` | Target one app                                     |

Run `wrangler types` (`pnpm cf-typegen`) after changing bindings in a
`wrangler.jsonc`. `pnpm format` / `pnpm format:check` run oxfmt.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from
  `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`
