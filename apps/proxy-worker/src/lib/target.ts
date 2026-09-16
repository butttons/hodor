/**
 * Building / resolving the upstream target for a registry item.
 *
 * Shared by the proxy (request-time) and the catalog probe script (verify-time)
 * so both apply the identical rules.
 *
 * An item's `url.host` is the concrete, per-instance upstream host — a user
 * registers their real value (e.g. `acme.myshopify.com`) directly; no
 * templating. `url.path` is an optional base prefix.
 *
 * `item.query` values are JEXL expressions (e.g. `secret('KEY')`, resolved like
 * headers) merged onto the upstream search params — for services that
 * authenticate via a query string (Gemini `?key=`, OpenWeather `?appid=`)
 * rather than a header.
 * @module
 */
import type { HeaderExpressionEngine } from "./engine";
import type { ProxyItem } from "./schema";

/** Build the upstream URL: item protocol/host/path + incoming path/query. */
export function buildUpstreamUrl(input: { reqUrl: URL; item: ProxyItem }): URL {
  const { reqUrl, item } = input;
  const base = item.url.path ?? "";
  const pathname = `${base}${reqUrl.pathname === "/" ? "" : reqUrl.pathname}`;
  const upstream = new URL(`${item.url.protocol || "https"}://${item.url.host}${pathname}`);
  upstream.search = reqUrl.search;
  return upstream;
}

/**
 * Resolve and merge an item's `query` expressions onto an upstream URL.
 * Values are JEXL expressions (e.g. `secret('KEY')`); the resolved params
 * override any client-sent values with the same name.
 */
export async function mergeQuery(input: {
  upstream: URL;
  item: ProxyItem;
  engine: HeaderExpressionEngine;
}): Promise<void> {
  const { item, engine } = input;
  if (!item.query || Object.keys(item.query).length === 0) return;
  const resolved = await engine.resolveHeaders(item.query);
  for (const [name, value] of Object.entries(resolved))
    input.upstream.searchParams.set(name, value);
}
