---
name: hodor
description: Call services through a Hodor proxy with header X-Authorization: Bearer $HPT, or run apex admin with $HAT. Use for any proxied API call, key mint/rotate, or registry work.
---

# Hodor (canonical usage)

Hodor is a self-hosted token-injecting proxy. Upstream credentials live at the edge; callers send one header and otherwise call the upstream API unchanged — same paths, same bodies.

## Naming

Two tokens, never mixed:

- `$HPT` — **proxy token**, service subdomains only (`https://<svc>.example.com`).
- `$HAT` — **admin token**, apex control plane only (`https://example.com/_/admin/*`, `/_/keys`, `/_/reflection`).

Every call carries the same header. Canonical form is the `hcurl` executable
(on `PATH`: `~/.local/bin` personal, `/usr/local/bin` shared):

```bash
#!/bin/bash
. ~/.hodor-env
exec curl -sS -H "X-Authorization: Bearer $HPT" "https://$1" "${@:2}"
# e.g. hcurl axiom.example.com/v1/datasets | jq
```

with `~/.hodor-env` (chmod 600, never commit) exporting bare tokens:

```bash
export HPT='<proxy-token>'
export HAT='<admin-token>'
```

Do NOT use an rc function (`hcurl()` in `~/.zshrc`/`~/.bashrc`) — functions
die with their shell and rc files are never sourced by agents, cron, or
non-interactive ssh. The executable is the single definition. (If both exist,
the function shadows the binary in interactive shells — delete the function.)

Point `BASH_ENV` at `~/.hodor-env` and non-interactive bash picks up `$HPT`/
`$HAT` directly too. Regenerate the file on every rotation.

Rules:

- Admin tokens live on the human workstation only. Servers and workers hold proxy tokens, never `$HAT`.
- **Never add `Authorization`** to hodor calls — the hodor JWT rides in `X-Authorization`; anything in `Authorization` is stripped before the upstream credential is stamped.
- Scoped copies for other humans are `HPT_<USER>`; on their machine the same value is plain `$HPT`.

## Mint (knowledge-based)

`body.secret` must equal the deployment's `HODOR_JWT_SECRET`. Key names are unique among live keys — duplicate mint returns 409 (revoke first, then mint).

```bash
curl -s -X POST https://example.com/_/keys -H 'content-type: application/json' \
  -d '{"secret":"<HODOR_JWT_SECRET>","name":"<name>","scopes":["proxy:call"],"integrations":[{"id":"<svc>"}]}' | jq -r .token
```

Claims: `integrations: [{id, only?, except?}]`, global `only`/`except` (`{methods?, paths?}`). `except` always wins; per-item rules narrow the globals. Scope new consumers to what they need, never all-by-default.

## Rotate (revoke-first, enforced by the 409)

```bash
J=$(curl -s https://example.com/_/admin/keys -H "X-Authorization: Bearer $HAT" \
  | jq -r '.keys[] | select(.name=="<name>") | .jti')
curl -s -X DELETE "https://example.com/_/admin/keys/$J" -H "X-Authorization: Bearer $HAT"
# then mint same name (above), update its storage, verify 200 through the proxy
```

Listing lags ~30s after a 204 — re-check before declaring dead. Revocation is one KV entry per key (`revoked:<jti>`).

## Key hygiene

- One key per consumer (daemon, human, box) — never share. Scope each to the
  integrations it needs, never all-by-default.
- One home per token: workstation `~/.hodor-env`, server `~/.config/hodor/env`
  (both 600). No copies in `/tmp`, repos, chat, or shell history — mint writes
  straight to the home file.
- Adding an integration = remint every key that needs it (revoke-first), ship,
  verify 200 from each consumer. Keys you skip keep working, minus the new item.
- Audit = ledger vs disk: `GET /_/admin/keys` names+jtis against local files
  (decode payload for name/jti — never print the token). Stale jti → delete
  the line. Zero-hit key (`hodor_traffic` by `blob3`) + no owner → revoke.
- Production vs local: `.dev.vars` is local-dev only. Minting against the
  deployed worker needs the production `HODOR_JWT_SECRET` (`401 Invalid
  secret` = wrong one).

## Reflection

`https://example.com/_/reflection` (apex only, same header) is the machine-readable source of truth: hosts + auth templates + non-secret identifiers per service.

## Secrets discipline

- Passwords/tokens/keys → worker secrets + local secret files. IDs/usernames → plain vars + `variable()` in templates.
- Never commit secret files; never print token values.
