"use client";
import { signInWithCustomToken } from "firebase/auth";
import { api } from "./api";
import { firebaseAuth } from "./firebase";
import { establishSession } from "./session";
import { readLocal, removeLocal, writeLocal } from "./storage";

/**
 * Email sign-in links: when the API can't email a 6-digit code it asks Firebase to email a
 * one-click link instead (`/auth/otp/request` answers `method: "link"`). The link reopens our
 * page with `?mode=signIn&oobCode=…`; we remember the address on this device so finishing
 * doesn't need it typed again.
 */
const KEY = "insights:link-email";

/** Storage blocked: the page asks for the email when the link is opened. */
export const rememberLinkEmail = (email: string) => writeLocal(KEY, email);
export const linkEmail = (): string => readLocal(KEY) ?? "";
export const forgetLinkEmail = () => removeLocal(KEY);

/** The sign-in code Firebase appended to this page's address, if it was opened from a link. */
export function emailLinkCode(search: string): string | null {
  const q = new URLSearchParams(search);
  return q.get("mode") === "signIn" ? q.get("oobCode") : null;
}

/** Redeem the link's code, sign in to Firebase and start our session. */
export async function signInWithEmailLinkCode(email: string, oobCode: string) {
  const { customToken } = await api<{ customToken: string }>("/auth/email-link/verify", { method: "POST", body: { email, oobCode } });
  const cred = await signInWithCustomToken(firebaseAuth(), customToken);
  await establishSession(cred.user);
  forgetLinkEmail();
}
