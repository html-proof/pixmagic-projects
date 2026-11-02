/**
 * Key rotation for Customer Messaging (keyRotation.ts): every value it keeps encrypted under
 * TOKEN_ENCRYPTION_KEYS (contacts' numbers and first names, checkouts' recovery links, texts' values
 * and bodies, test numbers) sealed again with the active key, under the same AAD.
 */
import { systemDb } from "@app/db";
import { keyVersionOf } from "@app/shared";
import { logger } from "../logger.js";
import { keyring } from "../tokens.js";
import { smsDecrypt, smsEncrypt, type SmsSecretKind } from "./common.js";

/** A ciphertext encrypted again with the active key, or null when it already is (or there is none). */
function again(storeId: string, kind: SmsSecretKind, ciphertext: string | null): string | null {
  if (!ciphertext || keyVersionOf(ciphertext) === keyring().active) return null;
  return smsEncrypt(storeId, kind, smsDecrypt(storeId, kind, ciphertext));
}

/**
 * Every row `page` picks, 500 at a time in id order (after the last id seen, so a row rewritten or
 * deleted meanwhile doesn't upset the paging), each passed to `rewrite`. A row that can't be
 * re-encrypted is logged and counted, and the rest go on.
 */
async function eachRow<T extends { id: string }>(
  table: string,
  page: (after: { id?: { gt: string } }) => Promise<T[]>,
  rewrite: (row: T) => Promise<number>,
): Promise<{ rewritten: number; failed: number }> {
  let rewritten = 0;
  let failed = 0;
  let last: string | undefined;
  for (;;) {
    const rows: T[] = await page(last ? { id: { gt: last } } : {});
    if (!rows.length) return { rewritten, failed };
    for (const r of rows) {
      try {
        rewritten += await rewrite(r);
      } catch (err) {
        logger.error({ err, table, id: r.id }, "a Customer Messaging value could not be re-encrypted");
        failed++;
      }
    }
    last = rows.at(-1)!.id;
  }
}

/**
 * Re-encrypts every Customer Messaging secret with the active key (step 2 of a key rotation). A row
 * is picked by its ciphertexts (one not on the active key) and written only over what was read, and
 * its updated_at stays as it was: retention (a checkout's) and the lists' order go by it. Returns the
 * rows rewritten; one that can't be decrypted fails the run at the end, after all the others.
 */
export async function reencryptSmsData(): Promise<number> {
  const current = `v${keyring().active}.`;
  const parts = [
    await eachRow(
      "sms_contacts",
      (after) =>
        systemDb.smsContact.findMany({
          where: { ...after, OR: [{ NOT: { phoneEnc: { startsWith: current } } }, { firstNameEnc: { not: null }, NOT: { firstNameEnc: { startsWith: current } } }] },
          orderBy: { id: "asc" },
          take: 500,
          select: { id: true, storeId: true, phoneEnc: true, firstNameEnc: true, updatedAt: true },
        }),
      async (c) => {
        const phone = again(c.storeId, "phone", c.phoneEnc);
        const name = again(c.storeId, "name", c.firstNameEnc);
        if (!phone && !name) return 0;
        return (
          await systemDb.smsContact.updateMany({
            where: { id: c.id, phoneEnc: c.phoneEnc, firstNameEnc: c.firstNameEnc },
            data: { ...(phone ? { phoneEnc: phone } : {}), ...(name ? { firstNameEnc: name } : {}), updatedAt: c.updatedAt },
          })
        ).count;
      },
    ),
    await eachRow(
      "sms_checkouts",
      (after) =>
        systemDb.smsCheckout.findMany({
          where: { ...after, recoveryUrlEnc: { not: null }, NOT: { recoveryUrlEnc: { startsWith: current } } },
          orderBy: { id: "asc" },
          take: 500,
          select: { id: true, storeId: true, recoveryUrlEnc: true, updatedAt: true },
        }),
      async (k) => {
        const url = again(k.storeId, "recovery", k.recoveryUrlEnc);
        if (!url) return 0;
        // Only over what was read: a checkout completed or expired meanwhile (its link cleared) isn't given it back.
        return (await systemDb.smsCheckout.updateMany({ where: { id: k.id, recoveryUrlEnc: k.recoveryUrlEnc }, data: { recoveryUrlEnc: url, updatedAt: k.updatedAt } })).count;
      },
    ),
    await eachRow(
      "sms_message_jobs",
      (after) =>
        systemDb.smsMessageJob.findMany({
          where: {
            ...after,
            OR: [
              { valuesEnc: { not: null }, NOT: { valuesEnc: { startsWith: current } } },
              { bodyEnc: { not: null }, NOT: { bodyEnc: { startsWith: current } } },
            ],
          },
          orderBy: { id: "asc" },
          take: 500,
          select: { id: true, storeId: true, valuesEnc: true, bodyEnc: true, updatedAt: true },
        }),
      async (m) => {
        const values = again(m.storeId, "values", m.valuesEnc);
        const body = again(m.storeId, "body", m.bodyEnc);
        if (!values && !body) return 0;
        // Only over what was read: a text sent meanwhile (its values cleared, its body written) isn't given the old ones back.
        return (
          await systemDb.smsMessageJob.updateMany({
            where: { id: m.id, valuesEnc: m.valuesEnc, bodyEnc: m.bodyEnc },
            data: { ...(values ? { valuesEnc: values } : {}), ...(body ? { bodyEnc: body } : {}), updatedAt: m.updatedAt },
          })
        ).count;
      },
    ),
    await eachRow(
      "sms_test_numbers",
      (after) =>
        systemDb.smsTestNumber.findMany({
          where: { ...after, NOT: { phoneEnc: { startsWith: current } } },
          orderBy: { id: "asc" },
          take: 500,
          select: { id: true, storeId: true, phoneEnc: true },
        }),
      async (t) => {
        const phone = again(t.storeId, "test_phone", t.phoneEnc);
        if (!phone) return 0;
        return (await systemDb.smsTestNumber.updateMany({ where: { id: t.id, phoneEnc: t.phoneEnc }, data: { phoneEnc: phone } })).count;
      },
    ),
  ];
  const rewritten = parts.reduce((n, p) => n + p.rewritten, 0);
  const failed = parts.reduce((n, p) => n + p.failed, 0);
  if (rewritten) logger.info({ count: rewritten }, "Customer Messaging data re-encrypted");
  // One unreadable value must not keep the rest on the old key, but the run must not end in a 0 that says "done".
  if (failed) throw new Error(`${failed} Customer Messaging row(s) could not be re-encrypted (logged with their table and id); ${rewritten} rows were`);
  return rewritten;
}
