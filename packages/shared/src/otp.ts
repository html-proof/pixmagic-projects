import { createHmac, randomInt } from "node:crypto";
import { safeEqual } from "./hmac.js";

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

/** Uniformly random 6-digit code (CSPRNG, no modulo bias). */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Codes are stored only as a peppered HMAC bound to the email; never in plaintext. */
export function hashOtp(code: string, email: string, pepper: string): string {
  return createHmac("sha256", pepper).update(`${email.toLowerCase()}:${code}`).digest("hex");
}

export function verifyOtp(code: string, email: string, pepper: string, storedHash: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return safeEqual(hashOtp(code, email, pepper), storedHash);
}
