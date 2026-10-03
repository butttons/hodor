# generated — compiled registry snapshot (per-instance build artifact)

`registry.json` is baked into the worker bundle at deploy time. The proxy hot
path (`getOne`/`getAll`) serves it from memory with zero KV reads. Shape:
`{ "snapshot": { "at", "apex", "count" }, "items": { id: proxyItem } }` —
exactly what `GET /_/admin/registry/snapshot` returns.

- **Committed placeholder** (`{ "snapshot": null, "items": {} }`) means
  live-KV mode: reads fall through to `HODOR_KV`, admin writes take effect
  immediately. Local dev and tests run this way.
- **Real snapshots live ONLY inside deploy copies** (`~/Work/*/hodor-proxy`).
  One curl, run from the copy (admin token in `HODOR_TOKEN`/`HAT`). Never
  commit a real snapshot to the public repo — the registry holds your
  integration topology:

  ```bash
  curl -s https://<apex>/_/admin/registry/snapshot \
    -H "X-Authorization: Bearer $HAT" > src/generated/registry.json
  npx wrangler deploy
  ```

- The hodor-first `rsync` (see root `AGENTS.md`) excludes
  `src/generated/registry.json`, so syncs never clobber a copy's snapshot.

Snapshot state is surfaced at runtime in `GET /_/admin/info` →
`registry.mode` (`snapshot`/`kv`) plus draft-vs-deployed drift.
