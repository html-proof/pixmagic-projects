/**
 * A customer's phone number as complete as Shopify has it, read live through the Admin GraphQL API
 * (the dashboard's Customers to follow up, WhatsApp Automation's customer list). A number lives in
 * more places than the profile's own field: the address typed at a checkout, the saved address, the
 * last order. Each comes with its address's country, which is what turns "0412 345 678" into
 * +61 412 345 678; the store's own country is the last resort, and the answer says when it was used.
 *
 * Nothing here is stored: these are fields of a query's answer, picked and passed on.
 */
import { systemDb } from "@app/db";
import { bestPhone, type CustomerPhoneSource, type PhoneCandidate } from "@app/shared";

/**
 * The phone-bearing fields of a Customer (API 2026-10). Every object here is nullable, so a store
 * whose app isn't approved for protected customer data gets nulls next to valid data, never a failed
 * query (`addressesV2` is left out for that reason: its connection is non-null).
 */
export const CUSTOMER_PHONE_FIELDS = `
  defaultPhoneNumber { phoneNumber smsMarketingConsent { state } }
  defaultAddress { phone countryCodeV2 }
  lastOrder { phone shippingAddress { phone countryCodeV2 } billingAddress { phone countryCodeV2 } }`;

/** The merchant's own address's country (not customer data): the last resort for a local number. */
export const SHOP_COUNTRY_FIELD = `shop { shopAddress { countryCodeV2 } }`;

export interface GqlPhoneAddress {
  phone?: string | null;
  countryCodeV2?: string | null;
}

export interface GqlCustomerPhones {
  defaultPhoneNumber?: { phoneNumber: string | null; smsMarketingConsent?: { state: string | null } | null } | null;
  defaultAddress?: GqlPhoneAddress | null;
  lastOrder?: { phone?: string | null; shippingAddress?: GqlPhoneAddress | null; billingAddress?: GqlPhoneAddress | null } | null;
}

export interface GqlShopCountry {
  shop?: { shopAddress?: { countryCodeV2?: string | null } | null } | null;
}

/** What a contact row says about its number. `phone` is the international form when there is one. */
export interface ContactPhone {
  phone: string | null;
  phoneE164: string | null;
  phoneRaw: string | null;
  phoneSource: CustomerPhoneSource | null;
  phoneCountryAssumed: boolean;
  /** Agreed to marketing by text message: Shopify records it on the profile's number only. */
  smsSubscribed: boolean;
}

export const NO_PHONE: ContactPhone = { phone: null, phoneE164: null, phoneRaw: null, phoneSource: null, phoneCountryAssumed: false, smsSubscribed: false };

/**
 * The customer's best number. A checkout's own addresses (`checkout`) come right after the profile's
 * number: they were typed for this very purchase. A number without "+" is read with its own
 * address's country; the profile's number with the customer's addresses' (default, then the last
 * order's, then the checkout's); `storeCountry` only when none of those reads it.
 */
export function customerPhone(c: GqlCustomerPhones | null | undefined, opts: { checkout?: { shipping?: GqlPhoneAddress | null; billing?: GqlPhoneAddress | null }; storeCountry?: string | null } = {}): ContactPhone {
  const order = c?.lastOrder ?? null;
  const shipping = opts.checkout?.shipping ?? null;
  const billing = opts.checkout?.billing ?? null;
  const addressCountry =
    c?.defaultAddress?.countryCodeV2 ?? order?.shippingAddress?.countryCodeV2 ?? order?.billingAddress?.countryCodeV2 ?? shipping?.countryCodeV2 ?? billing?.countryCodeV2 ?? null;
  const candidates: Array<PhoneCandidate<CustomerPhoneSource>> = [
    { raw: c?.defaultPhoneNumber?.phoneNumber, country: addressCountry, source: "customer" },
    { raw: shipping?.phone, country: shipping?.countryCodeV2 ?? addressCountry, source: "checkout_shipping" },
    { raw: billing?.phone, country: billing?.countryCodeV2 ?? addressCountry, source: "checkout_billing" },
    { raw: c?.defaultAddress?.phone, country: c?.defaultAddress?.countryCodeV2 ?? addressCountry, source: "default_address" },
    { raw: order?.phone, country: order?.shippingAddress?.countryCodeV2 ?? order?.billingAddress?.countryCodeV2 ?? addressCountry, source: "last_order" },
    { raw: order?.shippingAddress?.phone, country: order?.shippingAddress?.countryCodeV2 ?? addressCountry, source: "last_order_shipping" },
    { raw: order?.billingAddress?.phone, country: order?.billingAddress?.countryCodeV2 ?? addressCountry, source: "last_order_billing" },
  ];
  const best = bestPhone(candidates, opts.storeCountry);
  if (!best) return NO_PHONE;
  return {
    phone: best.e164 ?? best.raw,
    phoneE164: best.e164,
    phoneRaw: best.raw,
    phoneSource: best.source,
    phoneCountryAssumed: best.countryAssumed,
    smsSubscribed: best.source === "customer" && c?.defaultPhoneNumber?.smsMarketingConsent?.state === "SUBSCRIBED",
  };
}

/**
 * The country a store's local numbers are read in when nothing else says: its Shopify address's
 * (from the same query, `SHOP_COUNTRY_FIELD`), else the one chosen in Customer Messaging's setup.
 * Never guessed from the currency: "0412 345 678" read as a US number is someone else's.
 */
export async function storeCountryOf(storeId: string, answer: GqlShopCountry | null | undefined): Promise<string | null> {
  const fromShop = answer?.shop?.shopAddress?.countryCodeV2;
  if (fromShop) return fromShop.toUpperCase();
  const sms = await systemDb.smsSetup.findUnique({ where: { storeId }, select: { country: true } }).catch(() => null);
  return sms?.country?.toUpperCase() ?? null;
}
