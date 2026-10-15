import { memoryBlobs, memoryCoord, memoryMailer, memoryQueues, resetEnvCache, resetShopifyAppsCache, type FetchLike } from "@app/core";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { buildApp, type App } from "../src/app.js";
import type { Deps } from "../src/context.js";
import { LegacyUnavailableError, type LegacyPasswordCheck } from "../src/legacyFirebase.js";
import { fakeCognito } from "./fakeCognito.js";

export { fakeCognito };

/** Firebase accounts during the migration window: email -> password and account. */
export function fakeLegacy(): LegacyPasswordCheck & { accounts: Map<string, { uid: string; password: string; emailVerified: boolean; displayName: string | null }>; down: boolean } {
  const accounts = new Map<string, { uid: string; password: string; emailVerified: boolean; displayName: string | null }>();
  const self = {
    accounts,
    down: false,
    async verifyPassword(email: string, password: string) {
      if (self.down) throw new LegacyUnavailableError("Firebase is down (test)");
      const a = accounts.get(email);
      return a && a.password === password ? { uid: a.uid, emailVerified: a.emailVerified, displayName: a.displayName } : null;
    },
  };
  return self;
}

export interface InjectOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

export interface InjectResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  json(): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Fastify-style `inject` over Hono's in-process `app.request`. */
async function inject(app: App, opts: InjectOptions): Promise<InjectResponse> {
  const headers = new Headers(opts.headers);
  let body: string | undefined;
  if (opts.payload !== undefined) {
    if (typeof opts.payload === "string") body = opts.payload;
    else {
      body = JSON.stringify(opts.payload);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }
  const res = await app.request(opts.url, { method: opts.method, headers, body });
  const text = await res.text();
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => (out[k] = v));
  if (res.headers.getSetCookie().length) out["set-cookie"] = res.headers.getSetCookie().join(", ");
  return { statusCode: res.status, body: text, headers: out, json: () => JSON.parse(text) };
}

export interface TestCtx {
  app: { inject(opts: InjectOptions): Promise<InjectResponse> };
  deps: Deps & { coord: ReturnType<typeof memoryCoord>; queues: ReturnType<typeof memoryQueues> };
  mailer: ReturnType<typeof memoryMailer>;
  auth: ReturnType<typeof fakeCognito>;
  legacy: ReturnType<typeof fakeLegacy>;
  setFetch(f: FetchLike): void;
  /** Change env for one test; both env and the Shopify app registry are cached, so reset them. */
  setEnv(vars: Record<string, string>): void;
}

export async function setup(): Promise<TestCtx> {
  const mailer = memoryMailer();
  const auth = fakeCognito();
  const legacy = fakeLegacy();
  let fetchImpl: FetchLike = async () => {
    throw new Error("unexpected network call in test");
  };
  const deps = {
    auth,
    legacy,
    coord: memoryCoord(),
    queues: memoryQueues(),
    payloads: memoryBlobs(),
    mailer,
    fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike,
  };
  const hono = buildApp(deps);
  const setEnv = (vars: Record<string, string>) => {
    Object.assign(process.env, vars);
    resetEnvCache();
    resetShopifyAppsCache();
  };
  return { app: { inject: (o) => inject(hono, o) }, deps, mailer, auth, legacy, setFetch: (f) => (fetchImpl = f), setEnv };
}

export async function teardown(_ctx: TestCtx) {
  await disconnectDb();
}

export async function clean(ctx: TestCtx) {
  await resetDb();
  ctx.deps.coord.clear();
  ctx.deps.queues.clear();
  ctx.auth.reset();
  ctx.legacy.accounts.clear();
  ctx.legacy.down = false;
}

export const ORIGIN = { origin: "http://localhost:3001" };

/** The cookies a response set, as a request `cookie` header (deleted ones left out). */
export function cookiesFrom(res: InjectResponse): string {
  return (res.headers["set-cookie"] ?? "")
    .split(", ")
    .map((c) => c.split(";")[0]!)
    .filter((pair) => pair.includes("=") && !pair.endsWith("="))
    .join("; ");
}

/**
 * Sign a user in with email and password (creating their Cognito user, whose sub is `uid`, the
 * first time) and return a cookie header for subsequent requests.
 */
export async function signIn(ctx: TestCtx, uid: string, email: string, verified = true) {
  const u = ctx.auth.addUser({ sub: uid, email, emailVerified: verified });
  const res = await ctx.app.inject({ method: "POST", url: "/auth/login", headers: ORIGIN, payload: { email, password: u.password } });
  if (res.statusCode !== 200) throw new Error(`signIn failed: ${res.body}`);
  const cookie = cookiesFrom(res);
  const user = await userOf(u.sub);
  return { cookie, user, headers: { cookie, ...ORIGIN } };
}

/** The user a Cognito sub (as given to signIn) is linked to. */
export async function userOf(sub: string) {
  const id = await systemDb.authIdentity.findUniqueOrThrow({ where: { provider_subject: { provider: "cognito", subject: sub } }, include: { user: true } });
  return id.user;
}

export async function createWorkspace(ctx: TestCtx, headers: Record<string, string>, name = "Acme") {
  const res = await ctx.app.inject({ method: "POST", url: "/workspaces", headers, payload: { name } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return res.json().workspace.id as string;
}

export async function createStore(workspaceId: string, shop: string, scopes: string[], extra: Record<string, unknown> = {}) {
  return systemDb.store.create({
    data: { workspaceId, shopDomain: shop, grantedScopes: scopes, status: "active", timezone: "UTC", pixelIngestKey: `pk_${shop}`, ...extra },
  });
}

/**
 * A minimal browser over `inject`: keeps the cookies responses set (and drops deleted ones)
 * and sends them back, and POSTs from the web app's origin. For multi-redirect flows such as
 * OAuth, where several cookies change along the way.
 */
export function testBrowser(ctx: TestCtx) {
  const jar = new Map<string, string>();
  const absorb = (res: InjectResponse) => {
    // inject joins Set-Cookie headers with ", " (our cookies carry no Expires attribute).
    for (const cookie of res.headers["set-cookie"]?.split(", ") ?? []) {
      const [pair, ...attrs] = cookie.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1);
      const maxAge = attrs.map((a) => /^\s*max-age=(-?\d+)/i.exec(a)?.[1]).find((v) => v !== undefined);
      if (!value || (maxAge !== undefined && Number(maxAge) <= 0)) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
  const headers = (extra: Record<string, string> = {}) => ({
    ...extra,
    ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
  });
  return {
    jar,
    get: async (url: string) => absorb(await ctx.app.inject({ method: "GET", url, headers: headers() })),
    post: async (url: string, payload: unknown = {}) => absorb(await ctx.app.inject({ method: "POST", url, headers: headers(ORIGIN), payload })),
    /** Sign in with email and password, like the web app's login page. */
    async signIn(uid: string, email: string, verified = true) {
      const u = ctx.auth.addUser({ sub: uid, email, emailVerified: verified });
      const res = await this.post("/auth/login", { email, password: u.password });
      if (res.statusCode !== 200) throw new Error(`signIn failed: ${res.body}`);
      return userOf(u.sub);
    },
  };
}
