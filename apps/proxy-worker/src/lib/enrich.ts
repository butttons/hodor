/**
 * Enrichment from integrations.sh — turn a registrable domain's detected
 * integration surface into a candidate `proxyItem` for our catalog/registry.
 *
 * integrations.sh (`https://integrations.sh`) is an open, unauthenticated
 * registry of integration surfaces (REST/OpenAPI, MCP, GraphQL, CLI) tagged
 * with credentials and how to acquire them. Its `GET /api/{domain}/surface`
 * returns `{ summary, description, credentials{}, surfaces[] }`, where each
 * surface carries an `auth` block describing how its credential is attached.
 *
 * This helper maps the *first* HTTP/REST surface's auth onto our schema:
 *   - bearer  → `Authorization: 'Bearer ' + kv('{ID}_API_KEY')`
 *   - api_key → the named header (e.g. `x-api-key`), default `x-api-key`
 *   - basic   → `Authorization: 'Basic ' + base64(secret(id:secret))`
 *   - query   → a `query` injection param
 * and derives a sensible `kv('NAME')` placeholder + docs URL. The user
 * reviews/edits the shape (secret name, probe path) before PATCHing it to
 * their registry — it does the easy 80%, not the final decision.
 *
 * Credential types that don't map to a static header (oauth2, jwt flows, exotic
 * Nango enums) are surfaced as a note rather than a broken header.
 * @module
 */
import { AppHTTPException, ErrorCodes } from "./errors";

/** A credential in integrations.sh's `surface.credentials` map. */
export interface SurfaceCredential {
  type: string;
  label?: string;
  generateUrl?: string;
  header?: string;
  query?: string;
}

/** The candidate `proxyItem`-shaped enrichment we produce. */
export interface EnrichmentResult {
  id: string;
  url: { host: string };
  /** Suggested auth: `{ headerName: <jexl> }`. */
  headers?: Record<string, string>;
  /** Suggested query-param auth: `{ param: <jexl> }`. */
  query?: Record<string, string>;
  meta: {
    label: string;
    description?: string;
    docs: string;
  };
  /** Provenance of the auth mapping (which credential/scheme drove it). */
  credential: {
    type: string;
    label?: string;
    generateUrl?: string;
  };
  note?: string;
}

/** Pick a stable, realistic `kv('NAME')` from a domain + credential id. */
function secretName(domain: string, credentialId: string): string {
  const base = (domain.split(".")[0] ?? "API").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  // Strip the domain prefix already embedded in the credential id (e.g.
  // `stripe_api_key` under stripe.com → keep just `API_KEY`).
  let suffix = credentialId.toUpperCase().replace(/[^A-Z0-9_]/g, "_") || "API_KEY";
  const baseLower = base.toLowerCase();
  const suffixLower = suffix.toLowerCase();
  if (suffixLower.startsWith(baseLower)) suffix = suffix.slice(base.length);
  suffix = suffix.replace(/^_+/, "");
  if (!suffix) suffix = "API_KEY";
  return `${base}_${suffix}`;
}

/** Uppercase-underscore id for the catalog key. */
function itemId(domain: string): string {
  return domain
    .split(".")[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

/**
 * Fetch a domain's surface and map its HTTP surface's auth onto a candidate
 * proxyItem. Throws when the domain isn't catalogued or has no HTTP surface.
 */
export async function enrichDomain(rawDomain: string): Promise<EnrichmentResult> {
  const domain = rawDomain
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .toLowerCase();
  const res = await fetch(`https://integrations.sh/api/${domain}/surface`);
  if (res.status === 404) {
    throw new AppHTTPException({
      message: `Domain "${domain}" not found on integrations.sh`,
      code: ErrorCodes.NOT_FOUND,
      status: 404,
    });
  }
  if (!res.ok) {
    throw new AppHTTPException({
      message: `integrations.sh lookup failed (${res.status})`,
      code: ErrorCodes.CONFLICT,
      status: 502,
    });
  }
  const surface = (await res.json()) as {
    summary?: string;
    description?: string;
    credentials?: Record<string, SurfaceCredential>;
    surfaces?: Array<{
      kind?: string;
      url?: string;
      auth?: {
        entries?: Array<{
          use?: Array<{
            id?: string;
            mechanics?: { scheme?: string; in?: string; headerName?: string };
          }>;
        }>;
      };
    }>;
  };

  // Pick an HTTP/REST surface: skip CLI + MCP-only URLs, prefer one whose host
  // looks like a real API (`api.` subdomain) and whose auth has a concrete
  // header. kinds are usually null, so rank by URL + auth richness.
  const httpSurfaces =
    surface.surfaces?.filter(
      (s) =>
        s.kind !== "cli" && !!s.url?.includes("://") && !(s.url ?? "").split("/").includes("mcp"),
    ) ?? [];
  const rank = (s: { url?: string; auth?: { entries?: unknown[] } }) => {
    const host = (s.url ?? "").replace(/^https?:\/\//, "").split("/")[0];
    const apiHost = host.startsWith("api.") ? 2 : 0;
    const entries = (s.auth?.entries ?? []).length;
    return apiHost * 10 + entries;
  };
  httpSurfaces.sort((a, b) => rank(b) - rank(a));
  const httpSurface = httpSurfaces[0];
  const url = httpSurface?.url;
  const host = url ? url.replace(/^https?:\/\//, "").split("/")[0] : domain;

  // Collect the first HTTP-style auth entry referencing a known credential.
  const entries = httpSurface?.auth?.entries ?? [];
  let scheme: string | undefined;
  let headerName: string | undefined;
  let inWhere: string | undefined;
  let credentialId: string | undefined;
  for (const entry of entries) {
    for (const use of entry.use ?? []) {
      const mechanics = use.mechanics;
      if (!mechanics) continue;
      scheme = mechanics.scheme ?? scheme;
      inWhere = mechanics.in ?? inWhere;
      headerName = mechanics.headerName ?? headerName;
      credentialId = use.id ?? credentialId;
      break;
    }
    if (credentialId) break;
  }

  const credentials = surface.credentials ?? {};
  const credential = (credentialId && credentials[credentialId]) || Object.values(credentials)[0];
  const credType = credential?.type ?? "none";
  const name = secretName(domain, credentialId ?? domain.split(".")[0]);
  const id = itemId(domain);
  const docs = `https://${domain}`;
  const label = domain.replace(/(^\w|\.\w)/g, (chr) => chr.toUpperCase()).replace(/\./g, " ");

  let headers: Record<string, string> | undefined;
  let query: Record<string, string> | undefined;
  let note: string | undefined;

  if (credType === "bearer" || scheme === "bearerAuth") {
    headers = { Authorization: `'Bearer ' + kv('${name}')` };
  } else if (credType === "api_key") {
    if (inWhere === "query" || (credential as { query?: string }).query) {
      query = { [headerName ?? "api_key"]: `kv('${name}')` };
    } else if (headerName && headerName !== "authorization") {
      // Named non-Authorization header explicitly detected (e.g. `x-api-key`).
      headers = { [headerName]: `kv('${name}')` };
    } else {
      // Stripe-style: api_key credential but the API accepts it as a bearer
      // token. Default to `Authorization: Bearer` rather than a bare header.
      headers = { Authorization: `'Bearer ' + kv('${name}')` };
    }
  } else if (credType === "basic") {
    headers = {
      Authorization: `'Basic ' + base64(kv('${name}_ID') + ':' + kv('${name}_SECRET'))`,
    };
  } else if (headerName) {
    // Unknown type but a concrete header was detected (e.g. HTTP `Password`).
    headers = { [headerName]: `kv('${name}')` };
  } else {
    note =
      `Credential type "${credType}" (${credential?.label ?? credentialId}) doesn't map to a static ` +
      `request header (${["oauth2", "jwt"].includes(credType) ? "an OAuth/JWT flow" : "a custom flow"}). ` +
      `Verify how the API accepts this key before PATCHing.`;
  }

  return {
    id,
    url: { host },
    ...(headers ? { headers } : {}),
    ...(query ? { query } : {}),
    meta: {
      label,
      ...(surface.description ? { description: surface.description } : {}),
      docs,
    },
    credential: {
      type: credType,
      ...(credential?.label ? { label: credential.label } : {}),
      ...(credential?.generateUrl ? { generateUrl: credential.generateUrl } : {}),
    },
    ...(note ? { note } : {}),
  };
}
