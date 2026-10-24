import { expect } from "vitest";
import type { FetchLike } from "@app/core";
import { cookiesFrom, type InjectResponse, type TestCtx } from "./helpers.js";

/**
 * A fake of bizinsights' Nango environment (docs/nango.md) for the API tests. Every ad platform is
 * connected through Nango, so a test connects an account the way a merchant does: a connect session, the
 * person authorizing (Nango making a connection that carries the session's tags), the platform's
 * consent coming back through bizinsights' OAuth callback, then the finish. Nango's API and Google's
 * tokeninfo for the tokens Nango holds are answered here; the platform itself by the test's own fake.
 */

export const NANGO_KEY = "nango-secret-0123456789abcdef0123456789";
export const NANGO_WEBHOOK_KEY = "nango-webhook-signing-key-0123";
/** The settings that put a test server on this Nango. */
export const NANGO_ENV = { NANGO_SECRET_KEY: NANGO_KEY, NANGO_WEBHOOK_SECRET: NANGO_WEBHOOK_KEY, NANGO_PROVIDERS: "meta,google,adsense" };

export type NangoPlatform = "meta" | "google" | "adsense";
export const INTEGRATION: Record<NangoPlatform, string> = { meta: "bizinsights-meta-ads", google: "bizinsights-google-ads", adsense: "bizinsights-google-adsense" };
const PROVIDER_OF: Record<NangoPlatform, string> = { meta: "facebook", google: "google", adsense: "google" };
const SCOPE: Record<NangoPlatform, string> = { meta: "", google: "https://www.googleapis.com/auth/adwords openid", adsense: "https://www.googleapis.com/auth/adsense.readonly openid" };
const platformOf = (key: string) => (Object.entries(INTEGRATION).find(([, k]) => k === key)?.[0] ?? null) as NangoPlatform | null;

export interface NangoConnection {
  key: string;
  tags: Record<string, string>;
  token: string;
  refreshToken?: string | null;
  expiresAt: string | null;
  /** Nango can't renew it any more (the grant ended): it answers 424. */
  dead?: boolean;
}

export interface FakeNango {
  sessions: Array<Record<string, unknown>>;
  connections: Map<string, NangoConnection>;
  deleted: string[];
  /** What bizinsights handed Nango to import (POST /connections), as sent. */
  imports: Array<Record<string, unknown>>;
  /** The integrations Nango holds (all three unless a test takes one away). */
  integrations: Set<NangoPlatform>;
  /** The access token each platform's next connection holds. */
  tokens: Record<NangoPlatform, string>;
  /** A connection renewed with force_refresh gets this token (and fails when `refuseRenewal` names its platform). */
  renewed: Record<NangoPlatform, string>;
  refuseRenewal: Set<NangoPlatform>;
  /** How many times bizinsights asked Nango for a connection's token. */
  tokenFetches: number;
  /** Who Google's tokeninfo says a token Nango holds belongs to (null: it doesn't say). */
  googleSub: string | null;
  /** Wrap the test's platform fake: Nango's API, and Google's tokeninfo for Nango's tokens, are answered here. */
  fetch(platform: FetchLike): FetchLike;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeNango(opts: { googleClientId?: string } = {}): FakeNango {
  const n: FakeNango = {
    sessions: [],
    connections: new Map(),
    deleted: [],
    imports: [],
    integrations: new Set(["meta", "google", "adsense"]),
    tokens: { meta: "META_LONG_SECRET", google: "G_ACCESS", adsense: "AS_ACCESS" },
    renewed: { meta: "META_RENEWED", google: "G_RENEWED", adsense: "AS_RENEWED" },
    refuseRenewal: new Set(),
    tokenFetches: 0,
    googleSub: "100200300",
    fetch: (platform) => async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      if (u.host === "api.nango.dev") {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${NANGO_KEY}`);
        if (u.pathname === "/integrations" && method === "GET") {
          return json({ data: [...n.integrations].map((p) => ({ unique_key: INTEGRATION[p], display_name: p, provider: PROVIDER_OF[p], created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z", missing_fields: [] })) });
        }
        if (u.pathname === "/connect/sessions" && method === "POST") {
          n.sessions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({ data: { token: `nango_connect_session_${n.sessions.length}`, expires_at: "2099-01-01T00:00:00Z" } }, 201);
        }
        if (u.pathname === "/connections" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { provider_config_key: string; connection_id: string; credentials: { access_token: string; refresh_token?: string; expires_at?: string }; tags: Record<string, string> };
          n.imports.push(body);
          const p = platformOf(body.provider_config_key);
          if (!p || !n.integrations.has(p)) return json({ error: { code: "unknown_provider_config", message: "Integration not found" } }, 404);
          n.connections.set(body.connection_id, { key: body.provider_config_key, tags: body.tags, token: body.credentials.access_token, refreshToken: body.credentials.refresh_token ?? null, expiresAt: body.credentials.expires_at ?? null });
          return json({ id: 1, connection_id: body.connection_id, provider_config_key: body.provider_config_key, provider: PROVIDER_OF[p], tags: body.tags });
        }
        if (u.pathname === "/connections" && method === "GET") {
          const id = u.searchParams.get("connectionId")!;
          const c = n.connections.get(id);
          return json({ connections: c ? [{ id: 1, connection_id: id, provider: PROVIDER_OF[platformOf(c.key)!], provider_config_key: c.key, created: "2026-10-22T00:00:00Z", tags: c.tags }] : [] });
        }
        const one = /^\/connections\/([^/]+)$/.exec(u.pathname);
        if (one) {
          const id = decodeURIComponent(one[1]!);
          const c = n.connections.get(id);
          if (!c || c.key !== u.searchParams.get("provider_config_key")) return json({ error: { code: "not_found", message: "Connection not found" } }, 404);
          if (method === "DELETE") {
            n.deleted.push(id);
            n.connections.delete(id);
            return json({ success: true });
          }
          n.tokenFetches++;
          if (c.dead) return json({ error: { code: "invalid_credentials", message: "refresh failed" } }, 424);
          if (u.searchParams.get("force_refresh") === "true") {
            const p = platformOf(c.key)!;
            if (n.refuseRenewal.has(p)) return json({ error: { code: "refresh_token_external_error", message: "invalid_grant: Token has been expired or revoked." } }, 424);
            c.token = n.renewed[p];
            c.expiresAt = new Date(Date.now() + 3600_000).toISOString();
          }
          return json({ connection_id: id, provider_config_key: c.key, credentials: { type: "OAUTH2", access_token: c.token, ...(c.expiresAt ? { expires_at: c.expiresAt } : {}), raw: {} } });
        }
        return json({ error: { code: "not_found", message: `unexpected ${method} ${u.pathname}` } }, 404);
      }
      // Google's tokeninfo for a token Nango holds: issued to bizinsights' client, for its platform's scope.
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/tokeninfo") {
        const held = [...n.connections.values()].find((c) => c.token === u.searchParams.get("access_token"));
        const p = held ? platformOf(held.key) : null;
        if (p && p !== "meta") return json({ aud: opts.googleClientId ?? "g_client", ...(n.googleSub ? { sub: n.googleSub } : {}), scope: SCOPE[p] });
      }
      return platform(input, init);
    },
  };
  return n;
}

/** What each platform sends back to the OAuth callback after its consent screen: Google names the scopes granted, Meta doesn't. */
const CONSENT: Record<NangoPlatform, string> = {
  meta: "code=AQmeta-code&state=nango-state",
  adsense: `code=4%2Fgoogle-code&state=nango-state&scope=${encodeURIComponent(SCOPE.adsense)}`,
  google: `code=4%2Fgoogle-code&state=nango-state&scope=${encodeURIComponent(SCOPE.google)}`,
};

/** A browser's cookies after each answer: a later cookie replaces an earlier one of the same name. */
export function jar(...parts: string[]) {
  const cookies = new Map<string, string>();
  for (const pair of parts.flatMap((p) => p.split("; ")).filter((p) => p.includes("="))) cookies.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
  return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

export interface NangoConnect {
  /** POST …/nango/session. */
  start: InjectResponse;
  /** POST …/nango/finish (null when the session didn't start): `{ connected, provider }` or `{ choose, provider }`, or an error. */
  finish: InjectResponse | null;
  connectionId: string | null;
}

/**
 * "Continue with …" as a merchant does it in `headers`' browser: the session, the person authorizing at
 * Nango (a connection holding `token`, or the platform's default), the consent back through the
 * callback, and the finish.
 */
export async function connectThroughNango(
  ctx: TestCtx,
  nango: FakeNango,
  input: { base: string; provider: NangoPlatform; headers: Record<string, string>; token?: string },
): Promise<NangoConnect> {
  const { base, provider, headers } = input;
  const start = await ctx.app.inject({ method: "POST", url: `${base}/ads/${provider}/nango/session`, headers, payload: {} });
  if (start.statusCode !== 200) return { start, finish: null, connectionId: null };
  const s = nango.sessions[nango.sessions.length - 1]!;
  const connectionId = `conn-${nango.sessions.length}-${provider}`;
  const expiresAt = new Date(Date.now() + (provider === "meta" ? 60 * 86_400_000 : 3600_000)).toISOString();
  nango.connections.set(connectionId, { key: (s.allowed_integrations as string[])[0]!, tags: s.tags as Record<string, string>, token: input.token ?? nango.tokens[provider], expiresAt });
  let browser = jar(headers.cookie ?? "", cookiesFrom(start));
  const cb = await ctx.app.inject({ method: "GET", url: `/ads/nango/oauth-callback?${CONSENT[provider]}`, headers: { cookie: browser } });
  expect(cb.statusCode).toBe(308);
  browser = jar(browser, cookiesFrom(cb));
  const finish = await ctx.app.inject({ method: "POST", url: `${base}/ads/${provider}/nango/finish`, headers: { ...headers, cookie: browser }, payload: { nonce: start.json().nonce, connectionId } });
  return { start, finish, connectionId };
}
