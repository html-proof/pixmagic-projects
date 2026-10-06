import { createHmac } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { E2E_BASE_URL } from "../playwright.config";

export const uniqueEmail = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

/** Follow the email-verification link the Firebase emulator "sent". */
export async function verifyEmailInEmulator(email: string) {
  const res = await fetch("http://127.0.0.1:9099/emulator/v1/projects/demo-insights/oobCodes");
  const { oobCodes } = (await res.json()) as { oobCodes: Array<{ email: string; requestType: string; oobLink: string }> };
  const code = oobCodes.reverse().find((c) => c.email === email && c.requestType === "VERIFY_EMAIL");
  expect(code, "verification email").toBeTruthy();
  await fetch(code!.oobLink);
}

export async function latestOtp(email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const j = (await r.json()) as { messages?: Array<{ Subject: string }> };
    const m = j.messages?.[0]?.Subject.match(/(\d{6})/);
    if (m) return m[1]!;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("OTP email not received");
}

export async function signUp(page: Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/verify-email/);
}

/** Our App URL as Shopify opens it (after a managed install, or from the admin): signed query string. */
export function signedLaunchUrl(shop: string) {
  const params: Record<string, string> = { shop, timestamp: String(Math.floor(Date.now() / 1000)) };
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hmac = createHmac("sha256", "e2e_secret").update(message).digest("hex");
  return `/api/shopify/launch?${new URLSearchParams({ ...params, hmac })}`;
}

/** Shopify can't run in CI: answer its pages with a stub so redirects there are observable but inert. */
export async function stubShopify(page: Page) {
  await page.route(/^https:\/\/([a-z0-9-]+\.myshopify\.com|admin\.shopify\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Shopify (stub)</title><h1>Shopify (stub)</h1>" }),
  );
}

export function signedWebhook(topic: string, shop: string, payload: unknown, id: string) {
  const body = JSON.stringify(payload);
  return fetch(`${E2E_BASE_URL}/api/webhooks/shopify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": id,
      "x-shopify-hmac-sha256": createHmac("sha256", "e2e_secret").update(body).digest("base64"),
    },
    body,
  });
}
