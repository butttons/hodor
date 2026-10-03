---
name: hodor-cli
description: Generate a unified CLI for the integrations on a Hodor instance from their upstream OpenAPI specs. Use when someone wants typed commands, search, and params for calling through Hodor instead of raw hcurl.
---

# hodor-cli (unified CLI generator)

Build a per-instance CLI over `GET /_/reflection`: one command per live
integration, operations from each upstream's OpenAPI spec, transport identical
to hcurl (`https://<id>.<apex><path>` + `X-Authorization`). Spec-less
integrations stay reachable via a raw `call` passthrough — never drop them,
never fail the build for one bad spec.

## Prerequisites (ask for whatever is missing — do not spelunk)

- **Apex URL** of the instance, e.g. `https://example.com`.
- **Proxy JWT** (`proxy:call` scope). Env `HODOR_TOKEN` wins; else a token var.
  Read-only reflection + upstream GETs only — no minting, no admin writes.
- **node >= 22**. Network access to fetch upstream specs.
- Forge repo (`github.com/cloudflare/forge`) for the validation step.
  Docker is NOT needed — only Fern SDK generation needs it, and this skill
  doesn't generate SDKs.

## 1. Discover

```bash
curl -s https://<apex>/_/reflection -H "X-Authorization: Bearer $TOKEN"
```

Keep services with `meta.openapi` (reflection is already permission-filtered
to the token). Record the rest as `call`-only.

## 2. Fetch + validate each spec (warn + skip, never fail)

- Must JSON-parse (if YAML, convert first) and contain a `paths` object —
  else skip (spec URLs rot; docs pages return HTML).
- Must be OpenAPI 3.x — skip Swagger 2.0 with a warning (or convert 2.0→3.x
  first; Forge resolves 3.x only).

## 3. Bundle (one doc, rewritten for Hodor transport)

For each kept spec (`id` = registry id, `apexHost` from the apex URL):

1. **operationId required** — missing? Synthesize deterministically from
   method + path (`GET /api/cron/{task}` → `getApiCronByTask`; `{x}` → `ByX`).
   Auto-generated specs (Hono/Scalar) routinely omit them.
2. **Stamp `x-fern-sdk-group-name = [id, ...tag.split(".")]`, lowercased.**
   Forge silently drops unstamped ops. No tags? Fall back to the first
   meaningful path segment, skipping versions and params
   (`/v1/charges` → `charges`). Stripe-style tagless specs collapse into one
   giant group otherwise.
3. **Method name** = tail of operationId split on `[-_.]` — unless upstream
   sets `x-fern-sdk-method-name` (keep theirs).
4. **Backfill `description`** from `summary`, else `METHOD path (id)`.
   Forge hard-fails on description-less methods.
5. **Servers → per-operation `[{url: https://<id>.<apexHost>}]`.**
   Fold the spec's own server base path into every bundled path
   (`servers[0].url` pathname: Axiom `/v2`, Cloudflare `/client/v4`) —
   instances carry no base, so the caller must send it. Skip templated bases.
6. **Auth → `security: [{hodorAuth: []}]`** with
   `components.securitySchemes.hodorAuth = {type: apiKey, in: header,
   name: X-Authorization}`. Delete upstream `servers`/`security` per op.
   **Delete `x-forge-aliases`** — upstreams that dogfood Forge (Cloudflare)
   ship pre-stamped aliases that bypass Hodor routing/auth.
7. **Prefix component names `{Id}_*`** (`schemas|parameters|responses|
   requestBodies|headers|examples`) and rewrite all internal `$ref`s.
   Verify zero dangling refs.
8. **Path+method collision** across specs → prefix loser with `/<id>`
   (the runner strips it before send; rare, but handle it).

Emit `openapi: 3.1.0` if any input is 3.1, else `3.0.0`.

## 4. Validate with Forge (recommended)

```bash
git clone https://github.com/cloudflare/forge && cd forge && pnpm install
# tsx -e "import {init} ..." on the bundle: must resolve with zero
# "command metadata validation errors" and one command per integration id.
```

`init()` runs dependency-free in milliseconds even at 6k ops. Fix bundler
output, not the specs, until it passes.

## 5. Emit the CLI (index + runner, not codegen)

- **Index** (JSON, ~100–500KB): rows of
  `{cmd, group, method, verb, path, summary, desc, params:[{name, in,
  required}], hasBody}`. Full schemas stay in the bundle — the CLI ships the
  index, which is what keeps it light.
- **Runner** (one script, hcurl semantics): resolve
  `<cmd> [group] <method> [--param v] [--data json|@file] [--header K:V]`
  to `(host=<cmd>.<apex>, verb, path-template)` → substitute `{params}`,
  append query, send with `X-Authorization: Bearer`. Surface:
  - `<cmd>` lists groups; `<cmd> <group>` lists methods with summaries.
  - `search <words...>` — AND-match over command/group/method/opaque-id,
    then over summary+description. Load-bearing: upstream names vary wildly
    (`createDashboard` vs `PostChargesChargeCapture`).
  - `call <id> <METHOD> <path>` — raw passthrough for spec-less integrations.
  - `reflect` — live services. `--dry` prints the request without sending.
- Unknown `--param` or missing path param = error exit 2 with the valid list.
  Never print the token (`--dry` redacts it).

## 6. Verify (read-only)

One safe GET per generated integration (catalog `probe` path, or a list op
with `limit 1`). Expect upstream-shaped responses through the proxy; a 404
means a lost base path (step 3.5); 401/403 means token scope, not CLI bugs.

## Regen + hygiene

- Regenerate when specs drift, integrations are added, or grouping looks
  stale: discover → bundle → validate → index. The bundle is a build
  artifact; the index is the shipped one.
- Token storage follows the `hodor` skill: 600 files, `HODOR_TOKEN`
  override, never commit, never print.
