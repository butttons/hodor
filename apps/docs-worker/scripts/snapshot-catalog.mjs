/**
 * Build-time snapshot of the integration catalog for the docs site.
 *
 * Reads `catalog/*.json` from the repo root (via manifest.json) and writes a
 * lean, deterministic `public/catalog.json` that the docs worker serves and
 * searches server-side. Run before `wrangler dev` / `wrangler deploy` so the
 * page never depends on the GitHub raw URL at runtime.
 *
 * @module
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const publicDir = join(here, "../public");

/** Extract the exact secret names a catalog entry references in its templates. */
function extractSecretNames(raw) {
  const names = new Set();
  const text = JSON.stringify(raw);
  // `kv('NAME')`, `secret('NAME')`, `secret_store('NAME')` — the exact store
  // keys a caller must populate for this integration.
  for (const match of text.matchAll(/(?:kv|secret|secret_store)\('([^']+)'\)/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}

/** Normalize one catalog entry into the public snapshot shape. */
function snapshotEntry(raw) {
  return {
    id: raw.id,
    label: raw.meta?.label ?? raw.id,
    description: raw.meta?.description ?? "",
    host: raw.url.host,
    path: raw.url.path ?? "",
    headers: Object.keys(raw.headers ?? {}),
    // Exact secret names the caller must find, e.g. `AXIOM_API_KEY` for axiom.
    secrets: extractSecretNames(raw),
    docs: raw.meta?.docs ?? null,
    llms: raw.meta?.llms ?? null,
    openapi: raw.meta?.openapi ?? null,
    icon: raw.meta?.icon ?? null,
    probe: raw.probe ? { method: raw.probe.method, path: raw.probe.path } : null,
    variables: raw.variables ? Object.keys(raw.variables) : [],
    // The full catalog entry verbatim — what you'd PATCH to the registry.
    raw: raw,
  };
}

const manifest = JSON.parse(readFileSync(join(root, "catalog/manifest.json"), "utf8"));
const items = manifest
  .map((file) => {
    const raw = JSON.parse(readFileSync(join(root, "catalog", file), "utf8"));
    return snapshotEntry(raw);
  })
  .sort((a, b) => a.id.localeCompare(b.id));

// Single source of version truth is root package.json "version".
// (apps + src/version.ts are stamped by scripts/sync-version.mjs, never by hand.)
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { version } = rootPkg;

const snapshot = { version, count: items.length, items };
mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, "catalog.json"), JSON.stringify(snapshot, null, 2) + "\n");
console.log(`catalog snapshot: v${version}, ${items.length} items -> public/catalog.json`);
