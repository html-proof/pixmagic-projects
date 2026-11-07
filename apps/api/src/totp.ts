import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Codes from an authenticator app (RFC 6238 TOTP) for the app's own sign-in (localAuth.ts), with
 * the parameters Cognito used and every authenticator app expects: HMAC-SHA1, 6 digits, 30 seconds,
 * a 160-bit secret in base32 (account.ts builds the otpauth:// address from it).
 */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  return (bits.match(/.{5}/g) ?? []).map((c) => B32[parseInt(c, 2)]).join("");
}

function base32Key(secret: string): Buffer {
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("not a base32 secret");
    bits += i.toString(2).padStart(5, "0");
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}

export function totpCode(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / STEP_MS)));
  const h = createHmac("sha1", base32Key(secret)).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * The step a code belongs to, if it is this step's or one either side (clock drift, as Cognito
 * allowed), else null. The step lets a caller refuse the same code twice.
 */
export function totpStep(secret: string, code: string, at = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  for (const d of [0, -1, 1]) {
    const t = at + d * STEP_MS;
    if (timingSafeEqual(Buffer.from(totpCode(secret, t)), given)) return Math.floor(t / STEP_MS);
  }
  return null;
}
