import { systemDb } from "@app/db";

/**
 * Where the app's own sign-in (localAuth.ts) keeps its accounts and refresh tokens: PostgreSQL
 * (auth_accounts, auth_refresh_tokens) in production, a Map in tests. Also how it finds the people
 * Cognito knew: every Cognito user who ever signed in has an auth_identities row (provider
 * "cognito", subject = their sub), and moving them over keeps that sub, so nothing else changes.
 */
export type AccountMethod = "password" | "google";

export interface AuthAccountRow {
  sub: string;
  username: string;
  loginEmail: string | null;
  email: string;
  emailVerified: boolean;
  pendingEmail: string | null;
  name: string | null;
  picture: string | null;
  method: AccountMethod;
  passwordHash: string | null;
  googleSub: string | null;
  confirmed: boolean;
  enabled: boolean;
  totpSecret: string | null;
  totpPending: string | null;
  totpEnabled: boolean;
  tokensValidAfter: Date;
  movedFrom: string | null;
  movedAt: Date | null;
  createdAt: Date;
}

export type NewAuthAccount = Omit<AuthAccountRow, "createdAt" | "tokensValidAfter"> & { tokensValidAfter?: Date };
export type AccountPatch = Partial<Omit<AuthAccountRow, "sub" | "createdAt">>;

export interface RefreshTokenRow {
  sub: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** A Cognito user the app already knows from a sign-in (auth_identities). */
export interface CognitoIdentity {
  sub: string;
  username: string;
  email: string | null;
  method: AccountMethod;
}

/** A second account with the same address, user name or Google account. */
export class AccountExistsError extends Error {
  constructor(public field: string) {
    super(`an account with this ${field} exists`);
    this.name = "AccountExistsError";
  }
}

export interface AuthStore {
  bySub(sub: string): Promise<AuthAccountRow | null>;
  byUsername(username: string): Promise<AuthAccountRow | null>;
  /** A password account by its address (lower case). */
  byLoginEmail(email: string): Promise<AuthAccountRow | null>;
  byGoogleSub(googleSub: string): Promise<AuthAccountRow | null>;
  /** Throws AccountExistsError when the sub, user name, address or Google account is taken. */
  create(account: NewAuthAccount): Promise<AuthAccountRow>;
  /** Null when there is no such account. Throws AccountExistsError for a taken address. */
  update(sub: string, patch: AccountPatch): Promise<AuthAccountRow | null>;
  remove(sub: string): Promise<void>;
  addRefreshToken(tokenHash: string, sub: string, expiresAt: Date): Promise<void>;
  refreshToken(tokenHash: string): Promise<RefreshTokenRow | null>;
  revokeRefreshToken(tokenHash: string): Promise<void>;
  revokeRefreshTokens(sub: string): Promise<void>;
  /** The Cognito identity with this user name (a password user's is its sub, a Google one's "google_<id>"). */
  cognitoIdentityByUsername(username: string): Promise<CognitoIdentity | null>;
  /** The Cognito password identity with this address, the oldest if there were several. */
  cognitoPasswordIdentityByEmail(email: string): Promise<CognitoIdentity | null>;
  /** Everyone Cognito knew, oldest first (signInMove.ts: who still has to come over before Cognito goes). */
  cognitoIdentities(): Promise<CognitoIdentity[]>;
}

const method = (m: string): AccountMethod => (m === "google" ? "google" : "password");
const isUnique = (err: unknown) => (err as { code?: string }).code === "P2002";
const target = (err: unknown) => String((err as { meta?: { target?: unknown } }).meta?.target ?? "account");

function row(r: Omit<AuthAccountRow, "method"> & { method: string }): AuthAccountRow {
  return { ...r, method: method(r.method) };
}

const SELECT = {
  sub: true,
  username: true,
  loginEmail: true,
  email: true,
  emailVerified: true,
  pendingEmail: true,
  name: true,
  picture: true,
  method: true,
  passwordHash: true,
  googleSub: true,
  confirmed: true,
  enabled: true,
  totpSecret: true,
  totpPending: true,
  totpEnabled: true,
  tokensValidAfter: true,
  movedFrom: true,
  movedAt: true,
  createdAt: true,
} as const;

/** The production store: PostgreSQL through the system role (the tables are system-only). */
export function prismaAuthStore(): AuthStore {
  const one = async (where: Record<string, string>) => {
    const r = await systemDb.authAccount.findFirst({ where, select: SELECT });
    return r ? row(r) : null;
  };
  const identity = (i: { subject: string; username: string; email: string | null; method: string } | null): CognitoIdentity | null =>
    i ? { sub: i.subject, username: i.username, email: i.email?.toLowerCase() ?? null, method: method(i.method) } : null;
  return {
    bySub: (sub) => one({ sub }),
    byUsername: (username) => one({ username }),
    byLoginEmail: (email) => one({ loginEmail: email.toLowerCase() }),
    byGoogleSub: (googleSub) => one({ googleSub }),
    async create(a) {
      try {
        return row(await systemDb.authAccount.create({ data: a, select: SELECT }));
      } catch (err) {
        if (isUnique(err)) throw new AccountExistsError(target(err));
        throw err;
      }
    },
    async update(sub, patch) {
      try {
        const r = await systemDb.authAccount.updateMany({ where: { sub }, data: patch });
        if (r.count === 0) return null;
      } catch (err) {
        if (isUnique(err)) throw new AccountExistsError(target(err));
        throw err;
      }
      return one({ sub });
    },
    async remove(sub) {
      await systemDb.authAccount.deleteMany({ where: { sub } });
    },
    async addRefreshToken(tokenHash, sub, expiresAt) {
      await systemDb.authRefreshToken.create({ data: { tokenHash, sub, expiresAt } });
    },
    async refreshToken(tokenHash) {
      return systemDb.authRefreshToken.findUnique({ where: { tokenHash }, select: { sub: true, createdAt: true, expiresAt: true, revokedAt: true } });
    },
    async revokeRefreshToken(tokenHash) {
      await systemDb.authRefreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
    },
    async revokeRefreshTokens(sub) {
      await systemDb.authRefreshToken.updateMany({ where: { sub, revokedAt: null }, data: { revokedAt: new Date() } });
    },
    async cognitoIdentityByUsername(username) {
      return identity(await systemDb.authIdentity.findFirst({ where: { provider: "cognito", username }, select: { subject: true, username: true, email: true, method: true } }));
    },
    async cognitoPasswordIdentityByEmail(email) {
      return identity(
        await systemDb.authIdentity.findFirst({
          where: { provider: "cognito", method: "password", email: { equals: email, mode: "insensitive" } },
          orderBy: { createdAt: "asc" },
          select: { subject: true, username: true, email: true, method: true },
        }),
      );
    },
    async cognitoIdentities() {
      const rows = await systemDb.authIdentity.findMany({ where: { provider: "cognito" }, orderBy: { createdAt: "asc" }, select: { subject: true, username: true, email: true, method: true } });
      return rows.map((r) => identity(r)!);
    },
  };
}

/** In memory, for tests: the same rules (unique sub, user name, address and Google account). */
export function memoryAuthStore(identities: CognitoIdentity[] = []) {
  const accounts = new Map<string, AuthAccountRow>();
  const tokens = new Map<string, RefreshTokenRow>();
  const copy = (a: AuthAccountRow | undefined) => (a ? { ...a } : null);
  const find = (f: (a: AuthAccountRow) => boolean) => copy([...accounts.values()].find(f));
  const clash = (a: Pick<AuthAccountRow, "sub" | "username" | "loginEmail" | "googleSub">, except?: string) => {
    for (const o of accounts.values()) {
      if (o.sub === except) continue;
      if (o.sub === a.sub) return "sub";
      if (o.username === a.username) return "username";
      if (a.loginEmail && o.loginEmail === a.loginEmail) return "login_email";
      if (a.googleSub && o.googleSub === a.googleSub) return "google_sub";
    }
    return null;
  };
  const store: AuthStore = {
    bySub: async (sub) => copy(accounts.get(sub)),
    byUsername: async (username) => find((a) => a.username === username),
    byLoginEmail: async (email) => find((a) => a.loginEmail === email.toLowerCase()),
    byGoogleSub: async (googleSub) => find((a) => a.googleSub === googleSub),
    async create(a) {
      const c = clash(a);
      if (c) throw new AccountExistsError(c);
      const r: AuthAccountRow = { ...a, tokensValidAfter: a.tokensValidAfter ?? new Date(), createdAt: new Date() };
      accounts.set(a.sub, r);
      return { ...r };
    },
    async update(sub, patch) {
      const a = accounts.get(sub);
      if (!a) return null;
      const next = { ...a, ...patch };
      const c = clash(next, sub);
      if (c) throw new AccountExistsError(c);
      accounts.set(sub, next);
      return { ...next };
    },
    async remove(sub) {
      accounts.delete(sub);
      for (const [h, t] of tokens) if (t.sub === sub) tokens.delete(h);
    },
    async addRefreshToken(tokenHash, sub, expiresAt) {
      tokens.set(tokenHash, { sub, createdAt: new Date(), expiresAt, revokedAt: null });
    },
    refreshToken: async (tokenHash) => (tokens.has(tokenHash) ? { ...tokens.get(tokenHash)! } : null),
    async revokeRefreshToken(tokenHash) {
      const t = tokens.get(tokenHash);
      if (t && !t.revokedAt) t.revokedAt = new Date();
    },
    async revokeRefreshTokens(sub) {
      for (const t of tokens.values()) if (t.sub === sub && !t.revokedAt) t.revokedAt = new Date();
    },
    cognitoIdentityByUsername: async (username) => identities.find((i) => i.username === username) ?? null,
    cognitoPasswordIdentityByEmail: async (email) => identities.find((i) => i.method === "password" && i.email === email.toLowerCase()) ?? null,
    cognitoIdentities: async () => identities.map((i) => ({ ...i })),
  };
  return { ...store, accounts, tokens, identities };
}
