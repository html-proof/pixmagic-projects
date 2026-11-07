import * as crypto from "node:crypto";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Password hashes for the app's own sign-in (localAuth.ts), which takes over from Cognito.
 *
 * argon2id from node:crypto (Node 24.7 and later: no native package to build or bundle), with
 * OWASP's minimum settings (19 MiB, 2 passes, 1 lane): about 0.1 s a check. A Node without it
 * falls back to scrypt (also node:crypto). Each hash is a PHC string that carries its own
 * algorithm and settings, so either verifies anywhere and the settings can be raised later
 * (`needsRehash`) without anyone resetting a password.
 */
const ARGON = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
/** N = 2^15, r = 8: 32 MiB, under node's 64 MiB maxmem below. */
const SCRYPT = { ln: 15, r: 8, p: 1, keylen: 32 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** PHC strings use standard base64 without padding. */
const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");
const unb64 = (s: string) => Buffer.from(s, "base64");

type Argon = (algorithm: "argon2id", parameters: crypto.Argon2Parameters, callback: (err: Error | null, key: Buffer) => void) => void;
const argon2 = (crypto as unknown as { argon2?: Argon }).argon2;

function argon2id(password: string, salt: Buffer, s: { memory: number; passes: number; parallelism: number; tagLength: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2!("argon2id", { message: Buffer.from(password, "utf8"), nonce: salt, ...s }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function scrypt(password: string, salt: Buffer, s: { ln: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(Buffer.from(password, "utf8"), salt, s.keylen, { N: 2 ** s.ln, r: s.r, p: s.p, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  if (argon2) {
    const tag = await argon2id(password, salt, ARGON);
    return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${b64(salt)}$${b64(tag)}`;
  }
  const key = await scrypt(password, salt, SCRYPT);
  return `$scrypt$ln=${SCRYPT.ln},r=${SCRYPT.r},p=${SCRYPT.p}$${b64(salt)}$${b64(key)}`;
}

function params(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kv of s.split(",")) {
    const [k, v] = kv.split("=");
    if (k && v && /^\d+$/.test(v)) out[k] = Number(v);
  }
  return out;
}

/** Whether `password` is the one `stored` was made from. A hash this code can't read is a no. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  try {
    if (parts[1] === "argon2id" && parts.length === 6 && argon2) {
      const p = params(parts[3]!);
      const salt = unb64(parts[4]!);
      const want = unb64(parts[5]!);
      if (!p.m || !p.t || !p.p || want.length < 16) return false;
      const got = await argon2id(password, salt, { memory: p.m, passes: p.t, parallelism: p.p, tagLength: want.length });
      return timingSafeEqual(got, want);
    }
    if (parts[1] === "scrypt" && parts.length === 5) {
      const p = params(parts[2]!);
      const salt = unb64(parts[3]!);
      const want = unb64(parts[4]!);
      if (!p.ln || !p.r || !p.p || p.ln > 20 || want.length < 16) return false;
      const got = await scrypt(password, salt, { ln: p.ln, r: p.r, p: p.p, keylen: want.length });
      return timingSafeEqual(got, want);
    }
  } catch {
    return false;
  }
  return false;
}

/** A hash made with weaker settings than today's (or scrypt, where argon2id is now available). */
export function needsRehash(stored: string): boolean {
  if (!argon2) return !stored.startsWith("$scrypt$");
  if (!stored.startsWith("$argon2id$")) return true;
  const p = params(stored.split("$")[3] ?? "");
  return (p.m ?? 0) < ARGON.memory || (p.t ?? 0) < ARGON.passes;
}

/**
 * Something to compare against when there is no account, so "no such address" takes as long as
 * "wrong password" (no way to tell which addresses have accounts by timing a sign-in).
 */
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(12).toString("base64url"));
  await verifyPassword(password, await dummy);
}
