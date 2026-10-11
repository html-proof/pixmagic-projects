import { describe, expect, it } from "vitest";
import { classifyVisit, restVisit } from "../src/traffic";

describe("where a sale came from", () => {
  it("reads a Meta ad's tags: Instagram placement, paid, with the campaign", () => {
    expect(
      classifyVisit({
        landingPage: "https://shop.example/products/saree?utm_source=ig&utm_medium=paid&utm_campaign=Diwali%20sale&fbclid=IwAR123",
        referrerUrl: "https://l.instagram.com/",
      }),
    ).toEqual({ source: "instagram", medium: "paid", campaign: "Diwali sale", referrerHost: "l.instagram.com" });
    // Shopify's own parsed tags win over the URL's, and its "ad" tactic means paid.
    expect(classifyVisit({ source: "facebook", sourceType: "AD", utmParameters: { source: "facebook", campaign: "Retargeting" } })).toMatchObject({
      source: "facebook",
      medium: "paid",
      campaign: "Retargeting",
    });
  });

  it("knows a Google Ads click by its click id, and an organic Google search by its referrer", () => {
    expect(classifyVisit({ landingPage: "/collections/silk?gclid=Cj0K" })).toMatchObject({ source: "google", medium: "paid" });
    expect(classifyVisit({ landingPage: "/", referrerUrl: "https://www.google.co.in/" })).toEqual({ source: "google", medium: "unpaid", campaign: null, referrerHost: "google.co.in" });
  });

  it("an untagged link from Facebook or Instagram isn't called an ad", () => {
    expect(classifyVisit({ landingPage: "/?fbclid=abc", referrerUrl: "https://m.facebook.com/" })).toMatchObject({ source: "facebook", medium: "unpaid" });
    expect(classifyVisit({ landingPage: "/?fbclid=abc" })).toMatchObject({ source: "facebook", medium: "unpaid" });
  });

  it("email, WhatsApp, other websites, direct and unknown", () => {
    expect(classifyVisit({ landingPage: "/?utm_source=klaviyo&utm_medium=email&utm_campaign=Welcome" })).toMatchObject({ source: "email", medium: "email", campaign: "Welcome" });
    expect(classifyVisit({ source: "an unknown source", sourceType: "NEWSLETTER" })).toMatchObject({ source: "email", medium: "email" });
    expect(classifyVisit({ referrerUrl: "https://wa.me/" })).toMatchObject({ source: "whatsapp", medium: "unpaid" });
    expect(classifyVisit({ landingPage: "/", referrerUrl: "https://blog.example.org/post?x=1" })).toEqual({ source: "other", medium: "referral", campaign: null, referrerHost: "blog.example.org" });
    expect(classifyVisit({ landingPage: "/products/x", referrerUrl: null }, "web")).toMatchObject({ source: "direct", medium: "direct" });
    expect(classifyVisit({ source: "direct", sourceType: "DIRECT" })).toMatchObject({ source: "direct" });
    // No visit at all (a POS sale, a draft order): not recorded rather than "direct".
    expect(classifyVisit(null, "pos")).toMatchObject({ source: "unknown", medium: "unknown" });
    expect(classifyVisit({}, "pos")).toMatchObject({ source: "unknown" });
  });

  it("keeps only the host of a referrer and a short campaign name, never a URL", () => {
    const t = classifyVisit({ landingPage: `/?email=a%40b.com&utm_campaign=${"x".repeat(300)}`, referrerUrl: "https://news.example.com/a/b?token=secret" });
    expect(t.referrerHost).toBe("news.example.com");
    expect(t.campaign).toHaveLength(120);
    expect(JSON.stringify(t)).not.toMatch(/secret|a@b|email=/);
  });

  it("reads a REST order's landing_site and referring_site", () => {
    expect(restVisit({ landing_site: "/?utm_source=facebook&utm_medium=cpc", referring_site: "https://facebook.com/" })).toEqual({
      landingPage: "/?utm_source=facebook&utm_medium=cpc",
      referrerUrl: "https://facebook.com/",
    });
    expect(classifyVisit(restVisit({ landing_site: "/?utm_source=facebook&utm_medium=cpc" }))).toMatchObject({ source: "facebook", medium: "paid" });
    expect(restVisit({ landing_site: null, referring_site: "" })).toBeNull();
  });

  it("doesn't mistake look-alike words or hosts", () => {
    expect(classifyVisit({ referrerUrl: "https://notfacebook.com/" })).toMatchObject({ source: "other" });
    expect(classifyVisit({ referrerUrl: "https://google.evil.example/" })).toMatchObject({ source: "other" });
    expect(classifyVisit({ landingPage: "/?utm_source=fbshop" })).toMatchObject({ source: "direct" });
  });
});
