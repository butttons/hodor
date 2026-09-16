# hodor

> Hodor holds the door open. This project is the door.

A self-hosted **token-injecting HTTP reverse proxy** — configure an API
integration once, get a stable subdomain that injects your credentials
automatically. The self-hosted equivalent of exe.dev-style named proxies.

**Why the name:** each integration is a door. Hodor holds it open, hands your
credentials through, and lets you in.

## Philosophy

**Why not MCP? Why not an AI gateway?**

If you want MCP, go get an MCP server or gateway — there are good ones. If you
want model routing, spend controls, and an AI gateway, go get one of those
too. Hodor is neither.

Hodor does one narrow thing: puts every external service behind one stable
URL and handles the credentials. It speaks plain HTTPS in and out — any tool
that can make an HTTP request (curl, a cron, an agent, a browser) can use it.
Your tools keep their normal HTTP clients; hodor just stamps the credential
on the way upstream. No SDK, no protocol, no client to adopt.

## Inspiration

- **[exe.dev](https://exe.dev)** — the developer experience that made this
  feel inevitable: a stable subdomain, credentials handled, nothing to
  configure per call. Hodor is the self-hosted version of that idea.
- **[executor.sh](https://executor.sh)** and
  **[integrations.sh](https://integrations.sh)** — helped shape the catalog
  and the registry model: integrations you configure once, then point any
  caller at.

## Repo layout

| path                | package               | what                                            |
| ------------------- | --------------------- | ----------------------------------------------- |
| `apps/proxy-worker` | `@hodor/proxy-worker` | the deployed proxy (Cloudflare Worker)          |
| `apps/docs-worker`  | `@hodor/docs-worker`  | docs site (static assets worker) on `hodor.ing` |

The proxy owns `*.hodor.ing` (subdomain routing); the docs own the apex
`hodor.ing`.

## Commands

```bash
pnpm install
pnpm dev            # all apps in dev mode (wrangler dev)
pnpm type-check     # tsc --noEmit everywhere
pnpm test           # unit tests
pnpm build          # standalone server bundles (node + bun, in apps/proxy-worker)
pnpm deploy         # deploy all workers
pnpm cf-typegen     # regenerate worker binding types
```

The proxy also runs as a plain Node/Bun server (no Cloudflare):
`pnpm --filter @hodor/proxy-worker build && … start:node|start:bun` — see
[`apps/proxy-worker/README.md`](./apps/proxy-worker/README.md#self-host-on-node-or-bun-no-cloudflare).

## Deploy to Cloudflare

One worker does all the work; a second worker just hosts this docs site.

| Kind              | Name                   | Purpose                                                                               |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| KV namespace      | `HODOR_KV`             | encrypted secrets + registry                                                          |
| Secret (required) | `HODOR_ENCRYPTION_KEY` | AES-GCM master key (`openssl rand -base64 32`)                                        |
| Secret (required) | `HODOR_JWT_SECRET`     | signs minted API keys (`openssl rand -hex 32`)                                        |
| Var               | `HODOR_APP_URL`        | main/apex host (the control surface — `/_/admin`, `/_/reflection` — serves here only) |
| Analytics Engine  | `HODOR_ANALYTICS`      | audit traffic log (`hodor_traffic`)                                                   |

### One-click

The button creates a **private repo from a snapshot** of the app (not a fork)
and deploys it — your bindings, secrets and settings stay in your own copy.
Cloudflare reads `wrangler.jsonc`, **auto-provisions `HODOR_KV`** (updating the
namespace id), and the two required secrets are captured on the setup page
(descriptions come from `cloudflare.bindings` in `package.json`).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/butttons/hodor/tree/main/apps/proxy-worker)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/butttons/hodor/tree/main/apps/docs-worker)

### Manual

```bash
npx wrangler kv namespace create HODOR_KV   # paste id into apps/proxy-worker/wrangler.jsonc
cd apps/proxy-worker
npx wrangler deploy --secrets-file .dev.vars   # first deploy: uploads the two required secrets
# npx wrangler deploy                          # later deploys are plain
```

Then **add one proxied DNS record** — `A  *.hodor.ing → 192.0.2.0`,
orange-clouded. `192.0.2.0` is a dummy RFC-5737 address; the worker route
does the real routing, and worker routes don't create DNS records. First-level
wildcards are covered by Universal SSL — no custom cert. (Custom domains only
support single hosts, fine for the `hodor.ing` apex.)

## Updating

Your `wrangler.jsonc` is never overwritten; back up any other local changes
first. Two ways:

1. **GitHub Actions (recommended)** — in your snapshot repo, run the
   **Update Worker** action (optionally pin a tag, or leave empty for the
   latest release). It pulls the release source, preserves `wrangler.jsonc`,
   and commits.
2. **Manual (git)** — snapshots aren't forks, so the first merge needs
   `--allow-unrelated-histories`:

   ```bash
   git remote add upstream https://github.com/butttons/hodor.git   # once
   cp wrangler.jsonc wrangler.jsonc.bak
   git fetch upstream
   git merge -X theirs upstream/main --allow-unrelated-histories -m "Update"
   # git merge -X theirs upstream/main -m "Update"   # later updates
   mv wrangler.jsonc.bak wrangler.jsonc
   npx wrangler deploy
   ```

## Releases

Cut a release whenever the code you want deployed has landed on `main`:

```bash
git tag v0.1.1
git push origin v0.1.1
gh release create v0.1.1 --generate-notes --title "Hodor v0.1.1"
```
