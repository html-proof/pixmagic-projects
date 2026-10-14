import { memoryBlobs, memoryCoord, memoryMailer, memoryQueues, resetEnvCache, resetShopifyAppsCache, type FetchLike } from "@app/core";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { buildApp, type App } from "../src/app.js";
import type { AuthProvider } from "../src/authProvider.js";
import type { Deps } from "../src/context.js";

/**
 * Fake Firebase: an "ID token" is `idt|uid|email|verified`, the session cookie
 * is `sess|uid|email|verified`. Lets tests act as any user without the emulator.
 */
export function fakeAuth(): AuthProvider & {
  customTokens: string[];
  links: Array<{ email: string; continueUrl: string }>;
  /** Accounts created with a password (employee invitations), by email. */
  passwordUsers: Map<string, { uid: string; password: string; displayName: string; emailVerified: boolean }>;
  revoked: string[];
} {
  const parse = (t: string, prefix: string) => {
    const [p, uid, email, verified] = t.split("|");
    if (p !== prefix || !uid) throw new Error("bad token");
    return { uid, email, emailVerified: verified === "1" };
  };
  const customTokens: string[] = [];
  const links: Array<{ email: string; continueUrl: string }> = [];
  const passwordUsers = new Map<string, { uid: string; password: string; displayName: string; emailVerified: boolean }>();
  const revoked: string[] = [];
  return {
    customTokens,
    links,
    passwordUsers,
    revoked,
    /** Accounts exist for addresses that signed in before (uid `existing-<email>`) or were created here. */
    async findUserByEmail(email) {
      const u = passwordUsers.get(email);
      if (u) return { uid: u.uid, emailVerified: u.emailVerified };
      const row = await systemDb.user.findUnique({ where: { email } });
      return row ? { uid: row.firebaseUid, emailVerified: row.emailVerified } : null;
    },
    async createPasswordUser(input) {
      if (passwordUsers.has(input.email)) {
        const err = new Error("EMAIL_EXISTS") as Error & { code: string };
        err.code = "auth/email-already-exists";
        throw err;
      }
      const uid = `pw-${input.email}`;
      passwordUsers.set(input.email, { uid, password: input.password, displayName: input.displayName, emailVerified: input.emailVerified });
      return uid;
    },
    async revokeSessions(uid) {
      revoked.push(uid);
    },
    /** A sent link's code is `link-<email>`; redeeming yields uid `link-<email>`. */
    async sendEmailSignInLink(email, continueUrl) {
      links.push({ email, continueUrl });
    },
    async redeemEmailSignInLink(email, oobCode) {
      if (oobCode !== `link-${email}` || !links.some((l) => l.email === email)) throw new Error("INVALID_OOB_CODE");
      return `link-${email}`;
    },
    async verifyIdToken(t) {
      return { ...parse(t, "idt"), authTime: Math.floor(Date.now() / 1000) };
    },
    async createSessionCookie(t) {
      return t.replace(/^idt/, "sess");
    },
    async verifySessionCookie(c) {
      return parse(c, "sess");
    },
    async upsertVerifiedEmailUser(email) {
      return `otp-${email}`;
    },
    async createCustomToken(uid) {
      const t = `custom-${uid}`;
      customTokens.push(t);
      return t;
    },
  };
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
  auth: ReturnType<typeof fakeAuth>;
  setFetch(f: FetchLike): void;
  /** Change env for one test; both env and the Shopify app registry are cached, so reset them. */
  setEnv(vars: Record<string, string>): void;
}

export async function setup(): Promise<TestCtx> {
  const mailer = memoryMailer();
  const auth = fakeAuth();
  let fetchImpl: FetchLike = async () => {
    throw new Error("unexpected network call in test");
  };
  const deps = {
    auth,
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
  return { app: { inject: (o) => inject(hono, o) }, deps, mailer, auth, setFetch: (f) => (fetchImpl = f), setEnv };
}

export async function teardown(_ctx: TestCtx) {
  await disconnectDb();
}

export async function clean(ctx: TestCtx) {
  await resetDb();
  ctx.deps.coord.clear();
  ctx.deps.queues.clear();
}

export const ORIGIN = { origin: "http://localhost:3001" };

/** Sign a user in and return a cookie header for subsequent requests. */
export async function signIn(ctx: TestCtx, uid: string, email: string, verified = true) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/auth/session",
    headers: ORIGIN,
    payload: { idToken: `idt|${uid}|${email}|${verified ? 1 : 0}` },
  });
  if (res.statusCode !== 200) throw new Error(`signIn failed: ${res.body}`);
  const cookie = `__session=sess|${uid}|${email}|${verified ? 1 : 0}`;
  const user = await systemDb.user.findUniqueOrThrow({ where: { firebaseUid: uid } });
  return { cookie, user, headers: { cookie, ...ORIGIN } };
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
    /** Exchange a (fake) Firebase ID token for a session cookie, like the web app after sign-in. */
    async signIn(uid: string, email: string, verified = true) {
      const res = await this.post("/auth/session", { idToken: `idt|${uid}|${email}|${verified ? 1 : 0}` });
      if (res.statusCode !== 200) throw new Error(`signIn failed: ${res.body}`);
      return systemDb.user.findUniqueOrThrow({ where: { firebaseUid: uid } });
    },
  };
}
