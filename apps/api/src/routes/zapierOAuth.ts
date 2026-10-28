import { z } from "zod";
import { systemDb } from "@app/db";
import { logger, memberState } from "@app/core";
import {
  authorizeProblem,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  issueAuthorizationCode,
  zapierClientValid,
  zapierConfig,
  ZapierOAuthError,
  zapierReturnUrl,
  type AuthorizeParams,
} from "@app/core/zapier";
import { body, clientIp, HttpError, memberAllows, requireUser, requireWorkspace, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * bizinsights as the OAuth 2.0 provider of its Zapier app (docs/zapier.md, core zapier/oauth.ts).
 *
 * - GET /oauth/zapier/authorize: what the consent page (/connect/zapier) shows: the request checked
 *   (client, exact redirect URI, response_type=code, state), and the signed-in person's workspaces and
 *   stores, each saying whether they may allow Zapier there ("Manage integrations").
 * - POST /workspaces/:ws/stores/:storeId/zapier/authorize: Allow. The member's own sign-in (never a
 *   shared link or an API key), "Manage integrations" in that workspace, the store in it. Answers the
 *   redirect back to Zapier with a single-use code and the state as Zapier sent it.
 * - POST /oauth/token: Zapier's server exchanging a code, or a refresh token. Form-encoded or JSON;
 *   the client's secret in the body (client_secret_post) or in HTTP Basic. Answers RFC 6749's shapes.
 *
 * Until ZAPIER_CLIENT_ID, ZAPIER_CLIENT_SECRET and ZAPIER_REDIRECT_URI are set, all three answer
 * 503 `not_configured` (after asking who is calling, where they do).
 */

const NOT_CONFIGURED = "Zapier isn't set up for bizinsights yet.";

const authorizeSchema = z.object({
  client_id: z.string().max(200).default(""),
  redirect_uri: z.string().max(2000).default(""),
  response_type: z.string().max(40).default(""),
  state: z.string().max(2000).default(""),
});

/** Why the page can't go on, in words, by what was wrong with Zapier's request. Never redirected to. */
const PROBLEM: Record<NonNullable<ReturnType<typeof authorizeProblem>>, [string, string]> = {
  client: ["invalid_client", "This request doesn't come from bizinsights' Zapier app. Start again from Zapier."],
  redirect: ["invalid_redirect_uri", "This request would send you somewhere other than Zapier, so it was stopped. Start again from Zapier."],
  response_type: ["unsupported_response_type", "Zapier's request isn't one bizinsights supports. Start again from Zapier."],
  state: ["invalid_request", "Zapier's request is incomplete. Start again from Zapier."],
};

function checkRequest(p: AuthorizeParams) {
  if (!zapierConfig().configured) throw new HttpError(503, NOT_CONFIGURED, "not_configured");
  const problem = authorizeProblem(p);
  if (problem) throw new HttpError(400, PROBLEM[problem][1], PROBLEM[problem][0]);
}

/** The token endpoint's input: form-encoded (what Zapier sends by default) or JSON. */
async function tokenInput(c: Ctx): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  const raw: Record<string, unknown> = type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data") ? await c.req.parseBody().catch(() => ({})) : ((await body(c)) as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === "string" || typeof v === "number") out[k] = String(v);
  return out;
}

/** The client's id and secret: HTTP Basic (RFC 6749 §2.3.1, each form-encoded first) or the body. Both at once is refused. */
function clientCredentials(c: Ctx, input: Record<string, string>): { id: string; secret: string; basic: boolean } {
  const auth = c.req.header("authorization");
  const inBody = input.client_secret !== undefined;
  if (auth?.toLowerCase().startsWith("basic ")) {
    if (inBody) throw new ZapierOAuthError("invalid_request", "Send the client's credentials one way only.");
    let decoded = "";
    try {
      decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
    } catch {
      decoded = "";
    }
    const i = decoded.indexOf(":");
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, " "));
      } catch {
        return s;
      }
    };
    return { id: i < 0 ? "" : dec(decoded.slice(0, i)), secret: i < 0 ? "" : dec(decoded.slice(i + 1)), basic: true };
  }
  return { id: input.client_id ?? "", secret: input.client_secret ?? "", basic: false };
}

function oauthError(c: Ctx, err: ZapierOAuthError, basic: boolean) {
  // RFC 6749 §5.2's shape; `message` too, for whoever reads this app's usual error envelope.
  const status = err.error === "invalid_client" ? 401 : err.status;
  if (err.error === "invalid_client" && basic) c.header("www-authenticate", 'Basic realm="bizinsights"');
  c.header("pragma", "no-cache");
  return c.json({ error: err.error, error_description: err.description, message: err.description }, status as 400 | 401);
}

export function zapierOAuthRoutes(app: App, deps: Deps) {
  app.get("/oauth/zapier/authorize", async (c) => {
    const user = await requireUser(c, deps);
    const params = authorizeSchema.parse(c.req.query());
    checkRequest(params);
    const memberships = await systemDb.membership.findMany({ where: { userId: user.id }, include: { workspace: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } });
    const active = memberships.filter((m) => memberState(m) === "active");
    const stores = await systemDb.store.findMany({
      where: { workspaceId: { in: active.map((m) => m.workspaceId) }, status: { not: "uninstalled" } },
      select: { id: true, workspaceId: true, name: true, shopDomain: true },
      orderBy: { createdAt: "asc" },
    });
    return c.json({
      client: { name: "Zapier" },
      account: { email: user.email },
      workspaces: active.map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        // Allowing Zapier needs "Manage integrations" there (owners and admins have it).
        allowed: memberAllows(m, "integrations.manage"),
        stores: stores.filter((s) => s.workspaceId === m.workspaceId).map((s) => ({ id: s.id, name: s.name ?? s.shopDomain, shopDomain: s.shopDomain })),
      })),
      cancelUrl: zapierReturnUrl(params.redirect_uri, { error: "access_denied", state: params.state }),
    });
  });

  app.post("/workspaces/:ws/stores/:storeId/zapier/authorize", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "integrations.manage");
    if (!a.user || a.link) throw new HttpError(403, "Sign in to your own account to connect Zapier.", "forbidden");
    const store = await systemDb.store.findFirst({ where: { id: storeId, workspaceId: ws, status: { not: "uninstalled" } }, select: { id: true } });
    if (!store) throw new HttpError(404, "Not found", "not_found");
    const params = authorizeSchema.parse(await body(c));
    checkRequest(params);
    await limit(deps.coord, `rl:zapier:authorize:${a.user.id}`, LIMITS.zapierAuthorize);
    const code = await issueAuthorizationCode(deps.coord, { clientId: params.client_id, redirectUri: params.redirect_uri, userId: a.user.id, workspaceId: ws, storeId: store.id });
    logger.info({ workspaceId: ws, storeId: store.id }, "zapier authorization allowed");
    return c.json({ redirect: zapierReturnUrl(params.redirect_uri, { code, state: params.state }) });
  });

  app.post("/oauth/token", async (c) => {
    await limit(deps.coord, `rl:zapier:token:${clientIp(c)}`, LIMITS.zapierTokenIp);
    if (!zapierConfig().configured) return c.json({ error: "not_configured", error_description: NOT_CONFIGURED, message: NOT_CONFIGURED }, 503);
    const input = await tokenInput(c);
    let basic = false;
    try {
      const client = clientCredentials(c, input);
      basic = client.basic;
      if (!zapierClientValid(client.id, client.secret)) throw new ZapierOAuthError("invalid_client", "The client's credentials aren't bizinsights' Zapier app's.");
      c.header("pragma", "no-cache");
      if (input.grant_type === "authorization_code") {
        if (!input.code || !input.redirect_uri) throw new ZapierOAuthError("invalid_request", "code and redirect_uri are required.");
        return c.json(await exchangeAuthorizationCode(deps.coord, { code: input.code, redirectUri: input.redirect_uri, clientId: client.id }));
      }
      if (input.grant_type === "refresh_token") {
        if (!input.refresh_token) throw new ZapierOAuthError("invalid_request", "refresh_token is required.");
        return c.json(await exchangeRefreshToken({ refreshToken: input.refresh_token, clientId: client.id }));
      }
      throw new ZapierOAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
    } catch (err) {
      if (err instanceof ZapierOAuthError) {
        logger.info({ oauthError: err.error, grantType: input.grant_type }, "zapier token request refused");
        return oauthError(c, err, basic);
      }
      throw err;
    }
  });
}
