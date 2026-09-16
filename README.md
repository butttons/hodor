# hodor

A self-hosted **token-injecting HTTP reverse proxy** — configure an API
integration once, get a stable subdomain that injects your credentials
automatically.

## Deploy to Cloudflare

### Installation

The button creates a **private repo from a snapshot** of the app (not a fork)
and deploys it — your bindings, secrets and settings stay in your own copy.
Cloudflare reads `wrangler.jsonc`, **auto-provisions `HODOR_KV`** (updating the
namespace id), and the two required secrets are captured on the setup page
(descriptions come from `cloudflare.bindings` in `package.json`).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/butttons/hodor/tree/main/apps/proxy-worker)

(Want your own copy of the docs site too? Same button flow from
`apps/docs-worker` — optional, most people only need the proxy.)

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

One worker does all the work; a second worker just hosts the docs site.

| Kind              | Name                   | Purpose                                                                               |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| KV namespace      | `HODOR_KV`             | encrypted secrets + registry                                                          |
| Secret (required) | `HODOR_ENCRYPTION_KEY` | AES-GCM master key (`openssl rand -base64 32`)                                        |
| Secret (required) | `HODOR_JWT_SECRET`     | signs minted API keys (`openssl rand -hex 32`)                                        |
| Var               | `HODOR_APP_URL`        | main/apex host (the control surface — `/_/admin`, `/_/reflection` — serves here only) |
| Analytics Engine  | `HODOR_ANALYTICS`      | audit traffic log (`hodor_traffic`)                                                   |

## Usage

### How it works

- **One URL per service.** `openai.example.com` _is_ an integration. Subdomain
  routing — no path config, nothing to remember.
- **Credentials handled.** Store the key once, encrypted. Hodor builds the auth
  header at request time — callers never see a credential.
- **Plain HTTP in and out.** curl, scripts, agents, browsers. If it speaks
  HTTPS it works.

### Same calls, one key

Four services, four credentials, four leak surfaces — vs the same four calls
with one hodor key and nothing else. Same curl, same JSON, same responses; the
URL changed and the keys left the room.

```bash
# before: one key per service
curl -X POST https://api.linear.app/graphql -H "Authorization: lin_api_xxxx" \
  -d '{"query":"{ viewer { name } }"}'

# after: the hodor key, nothing else
hcurl linear.example.com/graphql -X POST -d '{"query":"{ viewer { name } }"}'
```

`hcurl` is a tiny shell script — save as `~/.local/bin/hcurl`
(`chmod +x`), tokens in `~/.hodor-env` (`chmod 600`, never commit):

```bash
#!/bin/bash
. ~/.hodor-env
exec curl -sS -H "X-Authorization: Bearer $HPT" "https://$1" "${@:2}"
```

```bash
export HPT='<proxy-token>'
export HAT='<admin-token>'
```

### Example

Configure once through a small admin API — no code, no redeploys. Four calls,
one-time setup (minting is the only open path — everything after needs the key):

```bash
# 1. Mint an admin key (secret must equal HODOR_JWT_SECRET — production, not .dev.vars)
HAT=$(curl -s -X POST https://example.com/_/keys \
  -H 'content-type: application/json' \
  --data "{\"secret\":\"$HODOR_JWT_SECRET\",\"name\":\"admin\",\"scopes\":[\"admin\"]}" | jq -r .token)

# 2. Store the key (encrypted at rest; hodor is the only reader)
curl -X PUT -H "X-Authorization: Bearer $HAT" \
  --data-binary '<the-api-key>' \
  https://example.com/_/admin/secrets/OPENAI_API_KEY

# 3. Register the integration (target, auth header, optional probe)
curl -X PATCH https://example.com/_/admin/registry/openai \
  -H "X-Authorization: Bearer $HAT" -H 'content-type: application/json' \
  --data '{
    "id": "openai",
    "url": { "host": "api.openai.com", "path": "/v1" },
    "headers": { "Authorization": "'Bearer ' + kv('OPENAI_API_KEY')" },
    "meta": { "label": "OpenAI", "description": "OpenAI API" },
    "probe": { "method": "GET", "path": "/v1/models" }
  }'

# 4. Call it
hcurl openai.example.com/v1/models
```

### Keys & permissions

One signed JWT per consumer. Restrictions use a single vocabulary — `only` /
`except` — globally and per integration. `except` always wins; per-item rules
narrow the globals, never widen.

```json
{
  "scopes": ["proxy:call"],
  "integrations": [
    { "id": "stripe" },
    { "id": "razorpay", "only": { "methods": ["GET", "HEAD"] } }
  ]
}
```

Stripe stays broad, Razorpay is read-only — on the same key. Mint at
`POST /_/keys`, revoke one key without touching the rest.

### Injecting secrets

Header values are JEXL expressions. Five helpers, picked per deployment:

- `kv('NAME')` — hodor's own encrypted KV store. Portable, works everywhere.
- `secret('NAME')` — plain worker secret binding. Zero extra dependencies.
- `secret_store('NAME')` — Cloudflare Secrets Store. Strongest isolation.
- `variable('NAME')` — plain-text env var. IDs, usernames, account IDs — never secrets.
- `process_env('NAME')` — host `process.env`. Standalone Node/Bun only.

Rule: passwords/tokens/keys → secrets; IDs/usernames → `vars` + `variable()`.
Example: `'Bearer ' + kv('OPENAI_API_KEY')`. Reserved helper names can't be
shadowed.

### DNS & TLS

The wildcard (`*.example.com`) is a worker **route**, and routes do not create
DNS — add the proxied `A` record for `*` pointing at `192.0.2.0` by hand.
Without it the worker deploys fine and serves nothing. The apex is the
opposite: attach it as a **custom domain** and Cloudflare provisions DNS +
certificate automatically. First-level wildcards ride Universal SSL, so no
certificate setup is needed.

### Security

- **Keys stay encrypted.** Credentials are AES-GCM ciphertext in KV; only
  hodor can decrypt them, and only at request time. Revoke one key in ~30
  seconds, or rotate the signing secret to void everything at once.
- **Complete audit log.** Every request is recorded — who called which
  integration, when, and what came back — including rejections and upstream
  failures. Query it over SQL, dashboard or API (see `llms.txt`).

Full reference for humans and agents: [`llms.txt`](./apps/docs-worker/public/llms.txt).
Live docs: [hodor.ing](https://hodor.ing). No Cloudflare? The same app runs as
a plain Node/Bun server — see
[`apps/proxy-worker/README.md`](./apps/proxy-worker/README.md#self-host-on-node-or-bun-no-cloudflare).

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

## Contributing to hodor

Repo layout, commands, and conventions live in [`AGENTS.md`](./AGENTS.md).

## Inspiration

- **[exe.dev](https://exe.dev)** — the developer experience that made this
  feel inevitable: a stable subdomain, credentials handled, nothing to
  configure per call. Hodor is the self-hosted version of that idea.
- **[executor.sh](https://executor.sh)** and
  **[integrations.sh](https://integrations.sh)** — helped shape the catalog
  and the registry model: integrations you configure once, then point any
  caller at.

## Philosophy

Hodor sits underneath whatever you already use — MCP servers and gateways, AI
gateways, agents, crons, plain scripts. It gives every external service one
stable URL and handles the credentials, speaking plain HTTPS in and out. Your
tools keep their normal HTTP clients; hodor stamps the credential on the way
upstream. No SDK, no protocol, no client to adopt.
