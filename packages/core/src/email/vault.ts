/**
 * Credential vault for the email module: envelope encryption.
 *
 * Every secret (OAuth refresh and access tokens, SMTP passwords, domain challenges, event data,
 * recipients' addresses) gets its own random 256-bit data key; the secret is sealed with it
 * (AES-256-GCM) and the data key is sealed with the active key-encryption key (KEK) from
 * EMAIL_CREDENTIAL_KEYS (TOKEN_ENCRYPTION_KEYS when that is empty). Both seals carry the AAD, which
 * binds the ciphertext to its row and purpose: a ciphertext copied into another row or another
 * workspace doesn't decrypt.
 *
 * The KEKs live in the app's secrets, never in the database. Rotating them re-wraps data keys only
 * (rewrap), without touching the secrets. To move the KEKs into a managed KMS, replace wrapKey /
 * unwrapKey: nothing else sees a KEK.
 *
 * Format: `env1.<kek version>.<wrapped data key>.<sealed secret>`, where both inner parts are
 * @app/shared's AES-GCM format with ':' in place of its '.' separators.
 */
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, keyVersionOf, parseKeyring, type Keyring } from "@app/shared";
import { env } from "../env.js";

let ring: { spec: string; keys: Keyring } | undefined;

/** The key-encryption keyring. Parsed once per key list. */
export function credentialKeyring(): Keyring {
  const e = env();
  const spec = e.EMAIL_CREDENTIAL_KEYS || e.TOKEN_ENCRYPTION_KEYS;
  if (ring?.spec !== spec) ring = { spec, keys: parseKeyring(spec) };
  return ring.keys;
}

const pack = (s: string) => s.replace(/\./g, ":");
const unpack = (s: string) => s.replace(/:/g, ".");

function wrapKey(dek: Buffer, aad: string): { wrapped: string; version: number } {
  const kek = credentialKeyring();
  const wrapped = encrypt(dek.toString("base64"), kek, `${aad}#dek`);
  return { wrapped, version: keyVersionOf(wrapped) };
}

function unwrapKey(wrapped: string, aad: string): Buffer {
  return Buffer.from(decrypt(wrapped, credentialKeyring(), `${aad}#dek`), "base64");
}

const dekRing = (dek: Buffer): Keyring => ({ active: 0, keys: new Map([[0, dek]]) });

/** Seal a secret for one row and purpose (`aad`). */
export function seal(plaintext: string, aad: string): string {
  const dek = randomBytes(32);
  const { wrapped, version } = wrapKey(dek, aad);
  const sealed = encrypt(plaintext, dekRing(dek), aad);
  dek.fill(0);
  return `env1.${version}.${pack(wrapped)}.${pack(sealed)}`;
}

/** Open a sealed secret. Throws when the AAD doesn't match (moved ciphertext) or the KEK is gone. */
export function open(value: string, aad: string): string {
  const [tag, , wrapped, sealed] = value.split(".");
  if (tag !== "env1" || !wrapped || !sealed) throw new Error("Malformed sealed value");
  const dek = unwrapKey(unpack(wrapped), aad);
  try {
    return decrypt(unpack(sealed), dekRing(dek), aad);
  } finally {
    dek.fill(0);
  }
}

/** The KEK version a sealed value's data key is wrapped with. */
export function sealedKeyVersion(value: string): number {
  return Number(value.split(".")[1]);
}

/** Whether a sealed value needs rewrapping (its data key is under an older KEK). */
export const needsRewrap = (value: string) => sealedKeyVersion(value) !== credentialKeyring().active;

/** Re-wrap a sealed value's data key with the active KEK. The secret itself is untouched. */
export function rewrap(value: string, aad: string): string {
  const [tag, , wrapped, sealed] = value.split(".");
  if (tag !== "env1" || !wrapped || !sealed) throw new Error("Malformed sealed value");
  const dek = unwrapKey(unpack(wrapped), aad);
  try {
    const next = wrapKey(dek, aad);
    return `env1.${next.version}.${pack(next.wrapped)}.${sealed}`;
  } finally {
    dek.fill(0);
  }
}

/** The AADs, in one place so every reader and writer agrees. */
export const AAD = {
  oauthRefresh: (accountId: string) => `email:oauth:${accountId}:refresh`,
  oauthAccess: (accountId: string) => `email:oauth:${accountId}:access`,
  smtpPassword: (accountId: string) => `email:smtp:${accountId}:password`,
  domainToken: (workspaceId: string, domain: string) => `email:domain:${workspaceId}:${domain}`,
  eventPayload: (workspaceId: string, source: string, externalId: string) => `email:event:${workspaceId}:${source}:${externalId}`,
  recipient: (workspaceId: string) => `email:recipient:${workspaceId}`,
};

/** For tests: forget the parsed keyring. */
export function resetCredentialKeyring() {
  ring = undefined;
}
