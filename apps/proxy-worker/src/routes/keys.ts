/**
 * API-key minting (the feedr pattern). A key is a JWT signed with `HODOR_JWT_SECRET`,
 * scoped to `proxy:call` / `admin` and optionally restricted to specific
 * integrations. Minting is knowledge-based (body.secret === HODOR_JWT_SECRET), so the
 * first admin key can be created before any token exists.
 * @module
 */
import { sign } from "hono/jwt";
import { zValidator } from "@hono/zod-validator";
import { createRouter } from "@/utils";
import { z } from "zod";
import { auditAdminCall, defer, requestMeta } from "@/lib/analytics";
import { getMintStore } from "@/lib/mints";
import { getRevocationStore } from "@/lib/revocation";
import { runtimeOf } from "@/lib/runtime";
import { AppHTTPException, ErrorCodes, validationHook } from "@/lib/errors";

const SIX_MONTHS = 60 * 60 * 24 * 180;

const accessRuleInput = z.object({
  methods: z.array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])).optional(),
  paths: z.array(z.string().min(1)).optional(),
});

const integrationGrantInput = z.object({
  id: z.string().min(1),
  only: accessRuleInput.optional(),
  except: accessRuleInput.optional(),
});

const mintKeyInput = z.object({
  secret: z.string().min(1),
  name: z.string().min(1),
  scopes: z.array(z.enum(["proxy:call", "admin"])).min(1),
  integrations: z.array(integrationGrantInput).optional(),
  only: accessRuleInput.optional(),
  except: accessRuleInput.optional(),
  expiresInSeconds: z.number().int().min(60).optional(),
  /**
   * Optional consumer context, forwarded verbatim to upstreams as
   * `X-Hodor-Ctx` by the proxy (strings as-is, JSON values stringified).
   */
  ctx: z.unknown().optional(),
});

export const keysApp = createRouter().post(
  "/",
  zValidator("json", mintKeyInput, validationHook),
  async (ctx) => {
    const input = ctx.req.valid("json");
    if (input.secret !== ctx.env.HODOR_JWT_SECRET) {
      throw new AppHTTPException({
        message: "Invalid secret",
        code: ErrorCodes.UNAUTHORIZED,
        status: 401,
      });
    }

    // Names are unique among live keys: one ledger record per name
    // (`key:<name>`), so a duplicate mint is a 409 naming the holder.
    // Rotation is revoke-first and accidents stay visible.
    const storage = (await runtimeOf(ctx)).storage;
    const mints = getMintStore(storage);
    const existing = await mints.get(input.name);
    const clash =
      existing && !(await getRevocationStore(storage).isRevoked(existing.jti))
        ? existing
        : undefined;
    if (clash) {
      throw new AppHTTPException({
        message: `Key name "${input.name}" is already live (jti ${clash.jti}, minted ${new Date(clash.iat * 1000).toISOString()}) — revoke it first`,
        code: ErrorCodes.CONFLICT,
        status: 409,
      });
    }

    const jti = crypto.randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + (input.expiresInSeconds ?? SIX_MONTHS);
    const payload = {
      jti,
      name: input.name,
      scopes: input.scopes,
      ...(input.ctx !== undefined ? { ctx: input.ctx } : {}),
      ...(input.integrations ? { integrations: input.integrations } : {}),
      ...(input.only ? { only: input.only } : {}),
      ...(input.except ? { except: input.except } : {}),
      iat,
      exp,
    };
    const token = await sign(payload, ctx.env.HODOR_JWT_SECRET);

    // Record the mint (metadata only — never the token) so /_admin/keys can
    // list who holds keys. Best-effort: a failed ledger write never fails the
    // mint; the key is already valid by signature.
    await mints.record(payload);
    defer(
      ctx,
      auditAdminCall({
        analytics: ctx.env.HODOR_AUDIT,
        event: {
          keyJti: "",
          keyName: "",
          method: "POST",
          path: "/_/keys",
          status: 201,
          detail: input.name,
          ...requestMeta(ctx.req),
        },
      }),
    );

    return ctx.json(
      {
        token,
        jti,
        name: input.name,
        scopes: input.scopes,
        ...(input.ctx !== undefined ? { ctx: input.ctx } : {}),
        ...(input.integrations ? { integrations: input.integrations } : {}),
        ...(input.only ? { only: input.only } : {}),
        ...(input.except ? { except: input.except } : {}),
        exp,
      },
      201,
    );
  },
);
