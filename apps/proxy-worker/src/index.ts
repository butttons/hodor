/**
 * hodor entrypoint. One Hono app:
 *  - `authMiddleware` verifies the bearer JWT; route guards then enforce scope +
 *    integration + path access.
 *  - The whole control surface lives under `/_` (main/apex host only):
 *    `/_/keys` (mint scoped API keys), `/_/admin/*` (admin surface),
 *    `/_/reflection` (instance introspection).
 *  - Every other path — and every path on a **subdomain** — falls through to
 *    the reverse proxy. Subdomains are pure forwarders: they never serve
 *    control-plane endpoints, not even `/_/...`.
 * Global `onError` renders the flat `{ code, message, status }` envelope.
 * @module
 */
import type { MiddlewareHandler } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { authMiddleware } from "@/lib/auth";
import { AppHTTPException, ErrorCodes } from "@/lib/errors";
import { adminApp } from "@/routes/admin";
import { keysApp } from "@/routes/keys";
import { proxyApp } from "@/routes/proxy";
import { reflectionApp } from "@/routes/reflection";
import { createRouter } from "@/utils";
import type { AppEnv } from "@/utils";

export { HeaderExpressionEngine } from "@/lib/engine";

const app = createRouter();

/**
 * Minimal app = auth + proxy only. Subdomain requests that hit control paths
 * are re-dispatched here so they go through the real proxy pipeline (auth,
 * integration resolution, header injection, forwarding) instead of touching
 * the control surface. Shares the app's error envelope.
 */
const forwarder = createRouter();
forwarder.use("*", authMiddleware);
forwarder.route("/", proxyApp);

/** Control paths serve the main/apex host only; subdomains always forward. */
const controlGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const mainHost = c.env.HODOR_APP_URL ? new URL(c.env.HODOR_APP_URL).host : "";
  const host = c.req.header("host") ?? "";
  if (mainHost && host !== mainHost) {
    return forwarder.fetch(c.req.raw, c.env, c.executionCtx);
  }
  return next();
};

/** Shared flat `{ code, message, status }` error envelope. */
function handleError(error: unknown, ctx: Context<AppEnv>) {
  if (error instanceof HTTPException) {
    const status = error.status ?? 400;
    console.error("request failed", {
      path: ctx.req.path,
      code: ErrorCodes.VALIDATION_FAILED,
      status,
      message: error.message,
    });
    return ctx.json(
      { code: ErrorCodes.VALIDATION_FAILED, message: error.message, status },
      status as never,
    );
  }
  if (error instanceof AppHTTPException) {
    console.error("request failed", {
      path: ctx.req.path,
      code: error.code,
      status: error.status,
      message: error.message,
    });
    return ctx.json(error.toJSON(), error.status as never);
  }
  console.error("unhandled error", { path: ctx.req.path, error });
  const message = error instanceof Error ? error.message : String(error);
  return ctx.json({ code: ErrorCodes.INTERNAL_ERROR, message, status: 500 }, 500);
}
app.onError(handleError);
forwarder.onError(handleError);

app.use("*", authMiddleware);
app.use("/_", controlGate);
app.use("/_/*", controlGate);
app.route("/_/keys", keysApp);
app.route("/_/admin", adminApp);
app.route("/_/reflection", reflectionApp);
app.route("/", proxyApp);

app.notFound(() => {
  throw new AppHTTPException({
    message: "Not found",
    code: ErrorCodes.NOT_FOUND,
    status: 404,
  });
});

export default app;
