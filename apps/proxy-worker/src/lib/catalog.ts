/**
 * Catalog discovery — a live, read-only lookup against the public repo.
 *
 * The catalog is a template/reference surface, not an auto-applier. Users find
 * an integration, grab its `proxyItem` shape (as-is or edited), and PATCH it to
 * their own registry. If an integration isn't in the catalog, the docs teach
 * how to author it.
 *
 * Source (env `HODOR_CATALOG_RAW_BASE`):
 *   ${HODOR_CATALOG_RAW_BASE}/manifest.json  → ["openai.json", ...]
 *   ${HODOR_CATALOG_RAW_BASE}/<file>         → one proxyItem definition
 * @module
 */
import { AppHTTPException, ErrorCodes } from "./errors";
import { proxyItem, type ProxyItem } from "./schema";

export interface CatalogLookup {
  items: ProxyItem[];
  /** id → why that item couldn't be loaded (e.g. invalid or unreadable). */
  errors: Record<string, string>;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new AppHTTPException({
      message: `Catalog fetch failed (${res.status}): ${url}`,
      code: ErrorCodes.CONFLICT,
      status: 502,
    });
  }
  return res.text();
}

/** List every catalog item, loading + validating each from the raw source. */
export async function listCatalog(rawBase: string): Promise<CatalogLookup> {
  let manifest: string[];
  try {
    manifest = JSON.parse(await fetchText(`${rawBase}/manifest.json`)) as string[];
  } catch (cause) {
    throw new AppHTTPException({
      message: `Unable to load catalog manifest: ${(cause as Error).message}`,
      code: ErrorCodes.CONFLICT,
      status: 502,
      cause,
    });
  }

  const lookup: CatalogLookup = { items: [], errors: {} };
  for (const file of manifest) {
    const id = file.replace(/\.json$/, "");
    try {
      const raw = await fetchText(`${rawBase}/${file}`);
      const parsed = proxyItem.safeParse(JSON.parse(raw));
      if (parsed.success) lookup.items.push(parsed.data);
      else
        lookup.errors[id] = `invalid item: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`;
    } catch (cause) {
      lookup.errors[id] = (cause as Error).message;
    }
  }
  return lookup;
}

/** Search the catalog by id / description (case-insensitive substring). */
export async function searchCatalog(input: {
  rawBase: string;
  query?: string;
}): Promise<CatalogLookup> {
  const lookup = await listCatalog(input.rawBase);
  if (!input.query) return lookup;
  const q = input.query.toLowerCase();
  lookup.items = lookup.items.filter(
    (item) =>
      item.id.toLowerCase().includes(q) ||
      item.meta.label.toLowerCase().includes(q) ||
      item.meta.description.toLowerCase().includes(q),
  );
  return lookup;
}

/** Fetch a single catalog item by id; throws NOT_FOUND when absent. */
export async function getCatalogItem(input: { rawBase: string; id: string }): Promise<ProxyItem> {
  const raw = await fetchText(`${input.rawBase}/${input.id.replace(/\.json$/, "")}.json`).catch(
    () => null as string | null,
  );
  if (!raw) {
    throw new AppHTTPException({
      message: `No catalog item "${input.id}"`,
      code: ErrorCodes.NOT_FOUND,
      status: 404,
    });
  }
  const parsed = proxyItem.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new AppHTTPException({
      message: `Catalog item "${input.id}" failed validation`,
      code: ErrorCodes.VALIDATION_FAILED,
      status: 400,
    });
  }
  return parsed.data;
}
