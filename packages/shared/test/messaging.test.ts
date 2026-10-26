import { describe, expect, it } from "vitest";
import { bestPhone, formatPhone, normalizePhone, phoneCodeTyped } from "../src/messaging.js";

describe("phoneCodeTyped", () => {
  it("tells a typed calling code from one added from a country", () => {
    expect(phoneCodeTyped("+61 412 345 678", "+61412345678")).toBe(true);
    expect(phoneCodeTyped("0044 7700 900123", "+447700900123")).toBe(true);
    expect(phoneCodeTyped("+61 412 345 678 ext 5", "+61412345678")).toBe(true);
    expect(phoneCodeTyped("61412345678", "+61412345678")).toBe(true);
    expect(phoneCodeTyped("0412 345 678", "+61412345678")).toBe(false);
    expect(phoneCodeTyped("412 345 678", "+61412345678")).toBe(false);
  });
});

describe("normalizePhone", () => {
  it("reads a local number with its address's country", () => {
    expect(normalizePhone("0412 345 678", "AU")?.e164).toBe("+61412345678");
    expect(normalizePhone("61412345678", "AU")?.e164).toBe("+61412345678");
    expect(normalizePhone("(415) 555-0100", "US")?.e164).toBe("+14155550100");
  });

  it("never turns a number that can't be North American into one", () => {
    // An Australian mobile typed locally at a US store: +1 041 234 5678 doesn't exist.
    expect(normalizePhone("0412 345 678", "US")).toBeNull();
    expect(normalizePhone("1 115 555 0100", "CA")).toBeNull();
    expect(normalizePhone("415 155 0100", "US")).toBeNull();
    // Typed with its country code, a number is taken as it is.
    expect(normalizePhone("+1 888 555 0100", null)?.e164).toBe("+18885550100");
  });
});

describe("formatPhone", () => {
  it("shows the whole number in groups", () => {
    expect(formatPhone("+61412345678")).toBe("+61 412 345 678");
    expect(formatPhone("+14155550100")).toBe("+1 415 555 0100");
    expect(formatPhone("+919876543210")).toBe("+91 987 654 3210");
    expect(formatPhone("+6591234567")).toBe("+65 9123 4567");
    expect(formatPhone("+447700900123")).toBe("+44 770 090 0123");
    expect(formatPhone("+97150123456")).toBe("+971 5012 3456");
  });

  it("splits off the right calling code for countries it has no local rules for", () => {
    expect(formatPhone("+79161234567")).toBe("+7 916 123 4567");
    expect(formatPhone("+36201234567")).toBe("+36 201 234 567");
    expect(formatPhone("+584121234567")).toBe("+58 412 123 4567");
    expect(formatPhone("+989121234567")).toBe("+98 912 123 4567");
    expect(formatPhone("+67712345")).toBe("+677 12 345");
    expect(formatPhone("+359881234567")).toBe("+359 881 234 567");
  });

  it("leaves what isn't an international number as it was", () => {
    expect(formatPhone("0412 345 678")).toBe("0412 345 678");
    expect(formatPhone(" +12 ")).toBe("+12");
  });
});

describe("bestPhone", () => {
  const src = <S extends string>(raw: string | null, country: string | null, source: S) => ({ raw, country, source });

  it("takes the first number that reads with its own country", () => {
    expect(bestPhone([src(null, "AU", "customer"), src("0412 345 678", "AU", "shipping"), src("+61400000000", null, "billing")])).toEqual({
      e164: "+61412345678",
      raw: "0412 345 678",
      source: "shipping",
      countryAssumed: false,
    });
  });

  it("uses the store's country only when no number reads otherwise, and says so", () => {
    expect(bestPhone([src("0412 345 678", null, "customer")], "AU")).toEqual({ e164: "+61412345678", raw: "0412 345 678", source: "customer", countryAssumed: true });
    // A number that reads with its own country wins over an earlier one that needs the store's.
    expect(bestPhone([src("0412 345 678", null, "customer"), src("+64 21 123 4567", null, "order")], "AU")?.source).toBe("order");
  });

  it("doesn't call a calling code the customer typed assumed", () => {
    expect(bestPhone([src("61412345678", null, "customer")], "AU")).toMatchObject({ e164: "+61412345678", countryAssumed: false });
  });

  it("keeps a number it can't read, as typed", () => {
    expect(bestPhone([src("  0412 345 678 ", null, "customer")])).toEqual({ e164: null, raw: "0412 345 678", source: "customer", countryAssumed: false });
    expect(bestPhone([src("", "AU", "customer"), src("n/a", "AU", "order")])).toBeNull();
  });
});
