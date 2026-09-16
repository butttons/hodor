# @hodor/proxy-worker

The deployed side of Hodor — the token-injecting reverse proxy behind
`*.hodor.ing`.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/butttons/hodor/tree/main/apps/proxy-worker)

The button creates a private repo from a snapshot of this app and deploys it.
Three things your copy needs before it serves traffic:

1. **The two required secrets** (`secrets.required` in `wrangler.jsonc`) — the
   **first** deploy uploads them from a file (`.env` or JSON format, e.g.
   `.dev.vars`):

   ```bash
   npx wrangler deploy --secrets-file .dev.vars
   ```

   Later deploys are plain `wrangler deploy` — secrets persist across
   deployments. (Or set them once with `wrangler secret put
HODOR_ENCRYPTION_KEY` / `HODOR_JWT_SECRET`; see `.dev.vars.example` for
   formats.)

2. **A KV namespace** — the worker stores encrypted secrets there:

   ```bash
   npx wrangler kv namespace create HODOR_KV
   # paste the returned id into wrangler.jsonc → kv_namespaces[0].id
   ```

3. **A domain (optional)** — add your zone to Cloudflare, then route it:

   - **Wildcard for the proxy (`*.your.domain`)** — this is a **worker
     route**, NOT a custom domain (custom domains only support apex/single
     hosts). Worker routes do **not** create DNS records — add a proxied
     wildcard DNS record in the zone so subdomains reach the edge:

     | Type | Name            | Content     | Proxy                  |
     | ---- | --------------- | ----------- | ---------------------- |
     | A    | `*.your.domain` | `192.0.2.0` | Proxied (orange cloud) |

     `192.0.2.0` is a dummy RFC-5737 address — the worker route does the real
     routing; the record just needs to exist and be proxied. First-level
     wildcards are covered by Universal SSL, so no custom cert is needed.

   - **Apex or single host (`your.domain`)** — a **custom domain** works and
     auto-provisions DNS + cert.

Then `wrangler deploy` (or just push — connected builds deploy); the secret
values above get you there on the first run.

## Updating

When a new [release](https://github.com/butttons/hodor/releases) is cut,
update your deployed copy:

1. In your snapshot repo, go to **Actions** > **Update Worker**
2. Click **Run workflow** — optionally enter a specific tag, or leave empty
   for the latest release

The workflow downloads the release source, preserves your `wrangler.jsonc`
(all bindings, secrets and settings intact), and commits the update. Any
local changes other than `wrangler.jsonc` are discarded — back them up first.

**Manual (git):** snapshots aren't forks, so the first merge needs
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

## Local development

```bash
pnpm dev             # wrangler dev, KV persists to ../../data
pnpm type-check
pnpm test            # vitest (plain node env)
pnpm deploy          # requires: KV namespace id + hodor.ing zone in CF account
```

## Self-host on Node or Bun (no Cloudflare)

The same app runs as a plain server — no worker runtime, KV, or Analytics
binding needed. Build a standalone bundle, then run it:

```bash
pnpm build           # esbuild → dist/node.js, bun build → dist/bun.js
pnpm start:node      # node dist/node.js
pnpm start:bun       # bun dist/bun.js
```

`dev:node` / `dev:bun` are watch-mode variants for iteration. Without a
Cloudflare KV binding the server uses an unstorage store: in-memory by
default, or a JSON-backed `fs` store when `HODOR_KV_DATA_DIR` is set (opt into
memory explicitly with `HODOR_KV_DRIVER=memory`).

Environment:

| var                      | default   | purpose                                             |
| ------------------------ | --------- | --------------------------------------------------- |
| `PORT`                   | `3000`    | listen port                                         |
| `HOST`                   | `0.0.0.0` | listen host                                         |
| `HODOR_JWT_SECRET`       | —         | signs minted keys (HS256); must be set              |
| `HODOR_ENCRYPTION_KEY`   | —         | encrypts stored secrets at rest; must be set        |
| `HODOR_CATALOG_RAW_BASE` | —         | catalog raw base URL (defaults to the public repo)  |
| `HODOR_KV_DATA_DIR`      | —         | persist registry/secrets to a directory (fs driver) |
| `HODOR_KV_DRIVER`        | `memory`  | force `memory` when `HODOR_KV_DATA_DIR` is set      |

`.dev.vars` is loaded for local runs (real env vars win). Analytics Engine
writes are a no-op on standalone.

## Keys & permissions

Keys are HS256 JWTs minted at `POST /_/keys` (body `secret` must equal
`HODOR_JWT_SECRET`). Production vs local: `.dev.vars` holds the **local-dev**
secret — minting against the deployed worker needs the **production** secret
(`wrangler secret`), or you get `401 Invalid secret`. Scopes: `proxy:call` /
`admin`. Access uses one vocabulary — `only` / `except` (`{methods?, paths?}`),
global and per integration (`integrations: [{id, only?, except?}]`). `except`
always wins; per-item rules narrow the globals. Example: Razorpay read-only
beside an unrestricted Stripe —
`integrations: [{"id": "stripe"}, {"id": "razorpay", "only": {"methods": ["GET", "HEAD"]}}]`.

Call through the proxy with the canonical `hcurl` executable (on `PATH`, resolves
its own token — no rc function, no exports; rc files are never sourced by agents,
cron, or non-interactive ssh): `hcurl openai.example.com/v1/models | jq`.

Two tokens, never mixed: `$HPT` (proxy, subdomains) and `$HAT` (admin, apex
`/_/admin/*` — workstation only, never on servers). Never send `Authorization`
— the hodor JWT rides in `X-Authorization`; `Authorization` is stripped before
the upstream credential is stamped.

Names are unique among live keys (`409` → revoke first, then mint). Revocation
is `DELETE /_/admin/keys/:jti` (admin-only, ~30s to propagate):

```bash
J=$(curl -s https://example.com/_/admin/keys -H "X-Authorization: Bearer $HAT" \
  | jq -r '.keys[] | select(.name=="<name>") | .jti')
curl -s -X DELETE "https://example.com/_/admin/keys/$J" -H "X-Authorization: Bearer $HAT"
```

Secrets discipline: passwords/tokens/keys → secrets (`kv()` / `secret()` /
`secret_store()`); IDs/usernames/account IDs → plain `vars` + `variable()`.
One key per consumer, scoped to what it needs.
