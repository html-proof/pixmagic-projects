import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { adAccessToken, encryptAdTokens, forgetNangoToken, memoryCoord, moveDirectAdConnectionsToNango, MOVE_RETRY_S, resetEnvCache, type FetchLike } from "@app/core";

/**
 * Moving the ad connections bizinsights' own sign-in made before every platform went through Nango
 * (docs/nango.md, "Connections made before Nango"): each sign-in's tokens are handed to Nango, Nango
 * proves it can keep them working, and only then do the rows hold the sealed Nango reference instead.
 * Nothing is revoked or deleted; a sign-in Nango can't take keeps working the old way.
 */

const NANGO_KEY = "nango-secret-0123456789abcdef0123456789";
const ENV = { META_APP_ID: "a", META_APP_SECRET: "s", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_ENABLED: "1", NANGO_SECRET_KEY: NANGO_KEY, NANGO_PROVIDERS: "meta,google,adsense" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const KEY = { meta: "bizinsights-meta-ads", google: "bizinsights-google-ads", adsense: "bizinsights-google-adsense" } as const;
type Provider = keyof typeof KEY;

interface Imported {
  provider_config_key: string;
  connection_id: string;
  credentials: { type: string; access_token: string; refresh_token?: string; expires_at?: string };
  tags: Record<string, string>;
}

interface Nango {
  fetchImpl: FetchLike;
  imports: Imported[];
  tokens: Map<string, { key: string; token: string; expiresAt: string | null }>;
  deleted: string[];
  /** GET /connections/:id calls, with whether they forced a renewal. */
  reads: Array<{ id: string; forced: boolean }>;
  integrations: Set<Provider>;
  refuseRenewal: boolean;
  /** Nango doesn't answer an import (the network, an outage). */
  importsDown: boolean;
  /** Runs while Nango takes an import (to change the rows meanwhile, as a token renewal of the old way would). */
  onImport?: () => Promise<void>;
  calls: number;
}

function fakeNango(): Nango {
  const n: Nango = {
    imports: [],
    tokens: new Map(),
    deleted: [],
    reads: [],
    integrations: new Set(["meta", "google", "adsense"]),
    refuseRenewal: false,
    importsDown: false,
    calls: 0,
    fetchImpl: async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      if (u.host !== "api.nango.dev") return json({ error: { message: `unexpected ${u.host}${u.pathname}` } }, 400);
      n.calls++;
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${NANGO_KEY}`);
      if (u.pathname === "/integrations") {
        return json({ data: [...n.integrations].map((p) => ({ unique_key: KEY[p], display_name: p, provider: p === "meta" ? "facebook" : "google", created_at: "x", updated_at: "x" })) });
      }
      if (u.pathname === "/connections" && method === "POST" && n.importsDown) throw new TypeError("fetch failed");
      if (u.pathname === "/connections" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Imported;
        n.imports.push(body);
        await n.onImport?.();
        n.tokens.set(body.connection_id, { key: body.provider_config_key, token: body.credentials.access_token, expiresAt: body.credentials.expires_at ?? null });
        return json({ id: 1, connection_id: body.connection_id, provider_config_key: body.provider_config_key, tags: body.tags });
      }
      const one = /^\/connections\/([^/]+)$/.exec(u.pathname);
      if (one) {
        const id = decodeURIComponent(one[1]!);
        const c = n.tokens.get(id);
        if (!c || c.key !== u.searchParams.get("provider_config_key")) return json({ error: { code: "not_found" } }, 404);
        if (method === "DELETE") {
          n.deleted.push(id);
          n.tokens.delete(id);
          return json({ success: true });
        }
        const forced = u.searchParams.get("force_refresh") === "true";
        n.reads.push({ id, forced });
        if (forced) {
          if (n.refuseRenewal) return json({ error: { code: "refresh_token_external_error", message: "unauthorized_client: Unauthorized" } }, 424);
          c.token = `RENEWED_${c.token}`;
          c.expiresAt = new Date(Date.now() + 3600_000).toISOString();
        }
        return json({ connection_id: id, provider_config_key: c.key, credentials: { type: "OAUTH2", access_token: c.token, ...(c.expiresAt ? { expires_at: c.expiresAt } : {}) } });
      }
      return json({ error: { code: "not_found", message: `unexpected ${method} ${u.pathname}` } }, 404);
    },
  };
  return n;
}

beforeAll(() => {
  Object.assign(process.env, ENV);
  resetEnvCache();
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  Object.assign(process.env, ENV);
  resetEnvCache();
  forgetNangoToken();
});

let k = 0;
async function store() {
  const user = await systemDb.user.create({ data: { email: `owner${++k}@x.com` } });
  const ws = await systemDb.workspace.create({ data: { name: `W${k}` } });
  const s = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `m${k}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-m${k}` } });
  return { ...s, userId: user.id };
}

/** One direct sign-in's accounts, as the old callback stored them: the same sealed tokens on every row. */
async function signIn(provider: Provider, s: { id: string; workspaceId: string; userId: string }, accounts: string[], t: { access: string; refresh?: string | null; expiresAt?: Date }, over: Record<string, unknown> = {}) {
  const enc = encryptAdTokens(s.id, provider, { accessToken: t.access, refreshToken: provider === "meta" ? null : (t.refresh ?? `R_${t.access}`), expiresAt: t.expiresAt ?? new Date(Date.now() + 1800_000) });
  const rows = [];
  for (const accountId of accounts) {
    rows.push(
      await systemDb.adConnection.create({
        data: { workspaceId: s.workspaceId, storeId: s.id, provider, accountId, accountName: accountId, currency: "USD", timezone: "UTC", connectedByUserId: s.userId, externalUserId: "p-1", ...enc, ...over },
      }),
    );
  }
  return rows;
}

describe("moving direct ad connections to Nango", () => {
  it("each sign-in becomes one Nango connection; the rows keep their ids, settings and days, and hold no token afterwards", async () => {
    const s = await store();
    const google = await signIn("google", s, ["111", "222"], { access: "G_ACCESS", refresh: "G_REFRESH" });
    await systemDb.adConnection.update({ where: { id: google[1]!.id }, data: { enabled: false } });
    const [sense] = await signIn("adsense", s, ["pub-77"], { access: "AS_ACCESS", refresh: "AS_REFRESH" });
    const metaEnds = new Date(Date.now() + 30 * 86_400_000);
    const meta = await signIn("meta", s, ["act_1", "act_2"], { access: "META_LONG", expiresAt: metaEnds });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: s.workspaceId, storeId: s.id, connectionId: google[0]!.id, provider: "google", accountId: "111", campaignId: "c", campaignName: "C", day: "2026-10-01", spend: 5 } });
    // Left alone: a grant that already ended, and a row whose person left (no token).
    const [ended] = await signIn("google", s, ["333"], { access: "G_DEAD", refresh: "G_DEAD_R" }, { status: "reconnect", errorCode: "auth_expired" });
    await signIn("meta", s, ["act_9"], { access: "LEFT" }, { accessTokenEnc: "", status: "reconnect" });

    const nango = fakeNango();
    const coord = memoryCoord();
    const result = await moveDirectAdConnectionsToNango(coord, { fetchImpl: nango.fetchImpl });
    expect(result).toEqual({ moved: 5, failed: 0, waiting: 0, left: 1 });

    // Three sign-ins, three imports, each with the tokens it held, tagged with ids only.
    expect(nango.imports.map((i) => [i.provider_config_key, i.credentials.access_token, i.credentials.refresh_token ?? null]).sort()).toEqual(
      [
        ["bizinsights-google-ads", "G_ACCESS", "G_REFRESH"],
        ["bizinsights-google-adsense", "AS_ACCESS", "AS_REFRESH"],
        ["bizinsights-meta-ads", "META_LONG", null],
      ].sort(),
    );
    for (const i of nango.imports) {
      expect(i.credentials.type).toBe("OAUTH2");
      expect(i.tags).toEqual({ end_user_id: s.userId, organization_id: s.workspaceId, bi_store: s.id, bi_provider: i.tags.bi_provider, bi_imported: "direct" });
    }
    expect(new Date(nango.imports.find((i) => i.provider_config_key === "bizinsights-meta-ads")!.credentials.expires_at!).getTime()).toBe(metaEnds.getTime());
    // Google's were renewed by Nango at once (proving its client works); Meta's long-lived token wasn't.
    const forcedOf = (key: string) => nango.reads.find((r) => nango.imports.find((i) => i.connection_id === r.id)!.provider_config_key === key)!.forced;
    expect([forcedOf("bizinsights-google-ads"), forcedOf("bizinsights-google-adsense"), forcedOf("bizinsights-meta-ads")]).toEqual([true, true, false]);

    const after = await systemDb.adConnection.findMany({ where: { id: { in: [...google, sense!, ...meta].map((r) => r.id) } }, orderBy: { accountId: "asc" } });
    expect(after).toHaveLength(5);
    for (const r of after) {
      expect(r).toMatchObject({ source: "nango", refreshTokenEnc: null, status: "active", externalUserId: "p-1" });
      expect(nango.imports.some((i) => i.connection_id === r.sourceLoginId && i.tags.bi_provider === r.provider)).toBe(true);
    }
    // One sign-in, one Nango connection: Google Ads' two accounts share it, and the hidden one stays hidden.
    const g = after.filter((r) => r.provider === "google");
    expect(new Set(g.map((r) => r.sourceLoginId)).size).toBe(1);
    expect(g.map((r) => r.enabled)).toEqual([true, false]);
    expect(await systemDb.adCampaignDaily.count({ where: { connectionId: google[0]!.id } })).toBe(1);
    // Tokens now come from Nango.
    expect(await adAccessToken(g[0]!, nango.fetchImpl)).toBe("RENEWED_G_ACCESS");
    const m = after.find((r) => r.provider === "meta")!;
    expect(await adAccessToken(m, nango.fetchImpl)).toBe("META_LONG");
    expect(m.accessTokenExpiresAt!.getTime()).toBe(metaEnds.getTime());
    // In each workspace's audit log, without anyone's name on it.
    expect(await systemDb.auditLog.count({ where: { action: "ads.moved_to_nango", actorUserId: null } })).toBe(3);

    // The ended grant is left for a reconnect, and nothing is ever deleted at Nango or revoked.
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: ended!.id } })).toMatchObject({ source: "direct", status: "reconnect" });
    expect(nango.deleted).toEqual([]);

    // Run again: nothing left to move.
    const imports = nango.imports.length;
    expect(await moveDirectAdConnectionsToNango(coord, { fetchImpl: nango.fetchImpl })).toEqual({ moved: 0, failed: 0, waiting: 0, left: 1 });
    expect(nango.imports).toHaveLength(imports);
  });

  it("a sign-in Nango can't keep working stays exactly as it was, and waits before it is tried again", async () => {
    const s = await store();
    const [row] = await signIn("google", s, ["111"], { access: "G_ACCESS", refresh: "G_REFRESH" });
    const nango = fakeNango();
    nango.refuseRenewal = true;
    const coord = memoryCoord();
    expect(await moveDirectAdConnectionsToNango(coord, { fetchImpl: nango.fetchImpl })).toEqual({ moved: 0, failed: 1, waiting: 0, left: 1 });
    // The connection Nango took is deleted again; the row still holds its own tokens.
    expect(nango.deleted).toEqual([nango.imports[0]!.connection_id]);
    const same = await systemDb.adConnection.findUniqueOrThrow({ where: { id: row!.id } });
    expect(same).toMatchObject({ source: "direct", sourceLoginId: null, accessTokenEnc: row!.accessTokenEnc, refreshTokenEnc: row!.refreshTokenEnc, status: "active" });
    // Not tried again on the next tick.
    expect(await moveDirectAdConnectionsToNango(coord, { fetchImpl: nango.fetchImpl })).toEqual({ moved: 0, failed: 0, waiting: 1, left: 1 });
    expect(nango.imports).toHaveLength(1);
    expect(MOVE_RETRY_S).toBeGreaterThanOrEqual(3600);
  });

  it("Nango not answering ends the run without making anyone wait: the next tick moves them", async () => {
    const s = await store();
    await signIn("adsense", s, ["pub-77"], { access: "AS_ACCESS", refresh: "AS_REFRESH" });
    await signIn("google", s, ["111"], { access: "G_ACCESS", refresh: "G_REFRESH" });
    const nango = fakeNango();
    nango.importsDown = true;
    const coord = memoryCoord();
    expect(await moveDirectAdConnectionsToNango(coord, { fetchImpl: nango.fetchImpl })).toEqual({ moved: 0, failed: 1, waiting: 0, left: 2 });
    nango.importsDown = false;
    expect(await moveDirectAdConnectionsToNango(coord, { fetchImpl: nango.fetchImpl })).toEqual({ moved: 2, failed: 0, waiting: 0, left: 0 });
  });

  it("a platform whose integration Nango doesn't hold yet isn't touched", async () => {
    const s = await store();
    await signIn("adsense", s, ["pub-77"], { access: "AS_ACCESS", refresh: "AS_REFRESH" });
    const [m] = await signIn("meta", s, ["act_1"], { access: "META_LONG", expiresAt: new Date(Date.now() + 86_400_000) });
    const nango = fakeNango();
    nango.integrations.delete("adsense");
    expect(await moveDirectAdConnectionsToNango(memoryCoord(), { fetchImpl: nango.fetchImpl })).toEqual({ moved: 1, failed: 0, waiting: 0, left: 1 });
    expect(nango.imports.map((i) => i.provider_config_key)).toEqual(["bizinsights-meta-ads"]);
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: m!.id } })).source).toBe("nango");
    expect((await systemDb.adConnection.findFirstOrThrow({ where: { provider: "adsense" } })).source).toBe("direct");
  });

  it("a Meta token that already ran out isn't handed to Nango: the next sync asks for a reconnect, as before", async () => {
    const s = await store();
    const [m] = await signIn("meta", s, ["act_1"], { access: "META_OLD", expiresAt: new Date(Date.now() - 86_400_000) });
    const nango = fakeNango();
    expect(await moveDirectAdConnectionsToNango(memoryCoord(), { fetchImpl: nango.fetchImpl })).toEqual({ moved: 0, failed: 1, waiting: 0, left: 1 });
    expect(nango.imports).toEqual([]);
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: m!.id } })).source).toBe("direct");
  });

  it("rows whose tokens the old way renewed meanwhile are left for the next run, and Nango's copy is let go", async () => {
    const s = await store();
    const [row] = await signIn("google", s, ["111"], { access: "G_ACCESS", refresh: "G_REFRESH" });
    const nango = fakeNango();
    nango.onImport = async () => {
      // A sync renewed the token the old way while Nango took it: the row's ciphertexts changed.
      const enc = encryptAdTokens(s.id, "google", { accessToken: "G_ACCESS_2", refreshToken: "G_REFRESH", expiresAt: new Date(Date.now() + 3600_000) });
      await systemDb.adConnection.update({ where: { id: row!.id }, data: { accessTokenEnc: enc.accessTokenEnc, refreshTokenEnc: enc.refreshTokenEnc } });
      nango.onImport = undefined;
    };
    const coord = memoryCoord();
    expect(await moveDirectAdConnectionsToNango(coord, { fetchImpl: nango.fetchImpl })).toEqual({ moved: 0, failed: 0, waiting: 0, left: 1 });
    expect(nango.deleted).toEqual([nango.imports[0]!.connection_id]);
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: row!.id } })).source).toBe("direct");
    // The next run moves it, with the token it holds now.
    expect(await moveDirectAdConnectionsToNango(coord, { fetchImpl: nango.fetchImpl })).toEqual({ moved: 1, failed: 0, waiting: 0, left: 0 });
    expect(nango.imports[1]!.credentials.access_token).toBe("G_ACCESS_2");
  });

  it("without Nango set up nothing moves and Nango isn't asked; the connections keep working the old way", async () => {
    const s = await store();
    await signIn("adsense", s, ["pub-77"], { access: "AS_ACCESS", refresh: "AS_REFRESH" });
    Object.assign(process.env, { NANGO_SECRET_KEY: "" });
    resetEnvCache();
    const nango = fakeNango();
    expect(await moveDirectAdConnectionsToNango(memoryCoord(), { fetchImpl: nango.fetchImpl })).toEqual({ moved: 0, failed: 0, waiting: 0, left: 0 });
    expect(nango.calls).toBe(0);
    expect((await systemDb.adConnection.findFirstOrThrow({ where: { provider: "adsense" } })).source).toBe("direct");
  });
});
