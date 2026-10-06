import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Envelope-free AES-256-GCM with key versioning. Keys come from env as
 * "1:<b64>,2:<b64>"; the FIRST entry encrypts, all entries can decrypt, which
 * lets you rotate keys without downtime (see docs/RUNBOOK.md).
 * Ciphertext format: v<version>.<iv b64>.<tag b64>.<data b64>
 */
export type Keyring = { active: number; keys: Map<number, Buffer> };

export function parseKeyring(spec: string): Keyring {
  const keys = new Map<number, Buffer>();
  let active: number | undefined;
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const idx = part.indexOf(":");
    const version = Number(part.slice(0, idx));
    const key = Buffer.from(part.slice(idx + 1), "base64");
    if (!Number.isInteger(version) || key.length !== 32) {
      throw new Error("TOKEN_ENCRYPTION_KEYS entries must be '<int>:<base64 32-byte key>'");
    }
    keys.set(version, key);
    active ??= version;
  }
  if (active === undefined) throw new Error("TOKEN_ENCRYPTION_KEYS is empty");
  return { active, keys };
}

export function encrypt(plaintext: string, ring: Keyring, aad = ""): string {
  const key = ring.keys.get(ring.active)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${ring.active}.${iv.toString("base64")}.${tag.toString("base64")}.${data.toString("base64")}`;
}

export function decrypt(payload: string, ring: Keyring, aad = ""): string {
  const [v, ivB64, tagB64, dataB64] = payload.split(".");
  if (!v?.startsWith("v") || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error("Malformed ciphertext");
  }
  const key = ring.keys.get(Number(v.slice(1)));
  if (!key) throw new Error(`Unknown key version ${v}`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function keyVersionOf(payload: string): number {
  return Number(payload.split(".")[0]?.slice(1));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
