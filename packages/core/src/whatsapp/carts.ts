/** Abandoned carts: a reminder the merchant sends by hand. The automatic ones are scheduled in events.ts. */
import { systemDb, type AbandonedCheckout, type Store } from "@app/db";
import { kindSetting } from "@app/shared";
import { WhatsappError } from "./errors.js";
import { marketingAllowed, scheduleMessage, type WaDeps } from "./messages.js";
import { contactFirstName, parseConfig, waDecrypt } from "./store.js";
import { cartValues } from "./values.js";

/** Checkout statuses a reminder can still go out for. */
export const OPEN_CHECKOUT = ["open", "reminded", "ineligible"];

/** "Send reminder": the cart reminder template, now, if the customer may receive it. */
export async function remindCart(store: Store, checkout: AbandonedCheckout, deps: Pick<WaDeps, "queues">) {
  if (!OPEN_CHECKOUT.includes(checkout.status)) throw new WhatsappError("This checkout has been completed or has expired.", 409, "checkout_closed");
  if (!checkout.recoveryUrlEnc) throw new WhatsappError("Shopify didn't provide a link back to this checkout.", 409, "no_checkout_link");
  const [settings, conn, contact] = await Promise.all([
    systemDb.whatsappSettings.findUnique({ where: { storeId: store.id } }),
    systemDb.whatsappConnection.findUnique({ where: { storeId: store.id } }),
    checkout.contactId ? systemDb.whatsappContact.findUnique({ where: { id: checkout.contactId } }) : null,
  ]);
  if (!conn) throw new WhatsappError("Connect WhatsApp first.", 409, "not_connected");
  if (!contact) throw new WhatsappError("There's no WhatsApp number for this checkout.", 409, "no_phone");
  const cfg = parseConfig(settings?.config);
  const s = kindSetting(cfg, "abandoned_cart_1");
  if (!s.templateName) throw new WhatsappError("Choose a cart reminder template on Abandoned carts first.", 409, "template_required");
  const template = await systemDb.whatsappTemplate.findUnique({ where: { connectionId_name_language: { connectionId: conn.id, name: s.templateName, language: s.language } } });
  if (!template || template.status !== "APPROVED") throw new WhatsappError("The cart reminder template isn't approved yet.", 409, "template_not_approved");
  if (template.category === "MARKETING" && !marketingAllowed(cfg, contact)) {
    throw new WhatsappError("This customer hasn't agreed to WhatsApp marketing, so a cart reminder can't be sent.", 409, "no_marketing_consent");
  }
  const { message, created } = await scheduleMessage(
    {
      store,
      kind: "abandoned_cart_1",
      dedupeKey: `cart:${checkout.checkoutToken}:manual`,
      contact,
      template: { name: s.templateName, language: s.language },
      mapping: s.mapping,
      values: cartValues(store, cfg, contactFirstName(contact), checkout.totalPrice, checkout.currency),
      scheduledFor: new Date(),
      checkoutId: checkout.id,
      clickUrl: waDecrypt(store.id, "recovery", checkout.recoveryUrlEnc),
    },
    deps,
  );
  if (!created) throw new WhatsappError("A reminder was already sent from here for this checkout.", 409, "already_reminded");
  return message;
}
