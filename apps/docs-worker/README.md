# @hodor/docs-worker

Static site for Hodor — hand-authored files served directly as a Cloudflare
**assets worker** on `hodor.ing` (the apex; the proxy owns `*.hodor.ing`). No
build step, no framework, no worker code.

## Files

- `public/index.html` — the landing page (self-contained HTML/CSS).
- `public/llms.txt` — the complete, agent-facing documentation.
- `public/robots.txt`, `public/sitemap.xml` — SEO basics.
- `public/logo*.svg/png` — branding assets.

Edit any file, then `pnpm deploy` — wrangler uploads the assets as-is.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/butttons/hodor/tree/main/apps/docs-worker)

The button creates a private repo from a snapshot of this app and deploys it.
Static assets workers need **no build command** — `wrangler deploy` uploads the
contents of `public/` directly. Point the `hodor.ing` custom domain at the
worker.

## Updating

When a new [release](https://github.com/butttons/hodor/releases) is cut,
update your deployed copy:

1. In your snapshot repo, go to **Actions** > **Update Worker**
2. Click **Run workflow** — optionally enter a specific tag, or leave empty
   for the latest release

The workflow downloads the release source, preserves your `wrangler.jsonc`
(all settings intact), and commits the update. Any local changes other than
`wrangler.jsonc` are discarded — back them up first.

## Commands

```bash
pnpm dev       # wrangler dev (serves ./public locally)
pnpm deploy    # upload ./public to Cloudflare
```
