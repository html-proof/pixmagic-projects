import type { Coord } from "@app/core";
import { HttpError } from "./context.js";

export interface Limit {
  /** Hits allowed per window; the next one is refused. */
  max: number;
  windowSec: number;
}

/**
 * Every per-key limit in one place, so they can be reviewed and tuned together. The coarse
 * per-IP limit on all API traffic is `globalLimit` (apps/aws/src/app.ts, behind AWS WAF's rate
 * rule at CloudFront); these sit underneath it for the endpoints worth abusing.
 */
export const LIMITS = {
  // ---- Sign-in (per IP unless named otherwise). Cognito throttles and locks out on top. ----
  // One address is often many people (an office, a campus, a mobile carrier's NAT puts thousands
  // behind one), so the per-IP limits only cap what one address can cost us (emails, Cognito
  // calls) and leave the protection of accounts to the per-address and per-account limits and to
  // Cognito's own lockouts. Sized for a shared address carrying a few hundred merchants.
  /** POST /auth/login, per IP and per address (a password guesser spreads over neither). */
  loginIp: { max: 150, windowSec: 300 },
  loginEmail: { max: 10, windowSec: 900 },
  /** POST /auth/signup: each one emails a code. */
  signupIp: { max: 60, windowSec: 3600 },
  /** Codes Cognito emails on request (sign-up, password reset, sign-in), per address and per IP. */
  codeEmail: { max: 3, windowSec: 900 },
  codeIp: { max: 60, windowSec: 3600 },
  /** Guesses at emailed codes (sign-up confirmation, password reset, sign-in), per IP. */
  codeVerifyIp: { max: 100, windowSec: 900 },
  /**
   * Guesses at a code we email ourselves to claim an address nobody proved (auth.ts, address
   * claims), per address: Cognito's own lockout doesn't stand behind these.
   */
  claimVerifyEmail: { max: 5, windowSec: 3600 },
  /** "Continue with Google" started and finished (two hits per sign-in), per IP. */
  oauthIp: { max: 200, windowSec: 300 },
  /**
   * Codes from an authenticator app (two-step verification: signing in, setting it up), per IP
   * and per account. Six digits are a million guesses; Cognito also ends a sign-in after a few wrong ones.
   */
  mfaVerifyIp: { max: 100, windowSec: 900 },
  mfaVerifyAccount: { max: 10, windowSec: 900 },
  /** Password, email and account changes, per user. */
  accountChange: { max: 10, windowSec: 3600 },
  /** Signing other devices out (Settings → Security), one at a time. */
  sessionRemove: { max: 30, windowSec: 600 },

  // ---- Signed-in actions ----
  /** Customer contact details, fetched live from Shopify (per workspace and user). */
  contacts: { max: 20, windowSec: 60 },
  /** Invitations, per workspace: each one sends an email from our domain. */
  invitations: { max: 20, windowSec: 3600 },
  /**
   * Invitations (workspace and employee) sent by one person a day, across every workspace they
   * run: anyone can make several workspaces, so the per-workspace cap alone doesn't stop a spammer.
   */
  invitationsPerUser: { max: 60, windowSec: 86_400 },
  /** Resending one invitation (each is an email to the same person), per invitation. */
  invitationResend: { max: 5, windowSec: 3600 },
  /** Opening an invitation link before signing in, per IP (a token is 256 bits; this only slows scanning). */
  invitePreviewIp: { max: 60, windowSec: 600 },
  /** The mail provider's delivery events (signed; this only caps a flood), per sending address. */
  mailEvents: { max: 600, windowSec: 60 },
  /** Accepting invitations, per IP and per user. */
  inviteAcceptIp: { max: 20, windowSec: 900 },
  inviteAcceptUser: { max: 10, windowSec: 900 },
  /** Changes to members' access, revocations and removals, per person making them. */
  teamChanges: { max: 120, windowSec: 600 },
  /** Dashboard CSV downloads, per user (each one reads a whole report). */
  dashboardExports: { max: 30, windowSec: 600 },
  /** "Check against Shopify now", per store: each one re-reads a week of orders from Shopify. */
  storeCheck: { max: 4, windowSec: 3600 },
  /** The check against Shopify's reports, per store: up to 21 live ShopifyQL calls each. */
  shopifyCheck: { max: 3, windowSec: 600 },
  /** New workspaces, per user. */
  workspaceCreate: { max: 10, windowSec: 3600 },
  /** New API keys, per workspace. */
  apiKeyCreate: { max: 10, windowSec: 3600 },
  /** Starting a store connection, per user ("already connected elsewhere" must not become a lookup service). */
  shopifyInstall: { max: 20, windowSec: 600 },
  /** "Refresh data", per store (keeps Shopify's rate limit for real work). */
  resync: { max: 1, windowSec: 300 },
  // ---- Inventory ----
  /** "Refresh stock", per store: each one reads every location's levels from Shopify. */
  inventoryRefresh: { max: 1, windowSec: 300 },
  /** Stock changes sent to Shopify, per user. */
  inventoryAdjust: { max: 60, windowSec: 600 },
  /** A product's images read live from Shopify, per user. */
  inventoryMedia: { max: 120, windowSec: 600 },
  /** Optional-scope refresh/revoke, per store: one Shopify call each. */
  scopes: { max: 3, windowSec: 10 },
  /**
   * Starting an ad account sign-in ("Continue with Meta / Google Ads / AdSense"), per user: each writes
   * a coordinator item, and its callback lists the login's accounts against the platform's quota (Google
   * Ads operations are shared by every merchant). The callback needs a fresh one, so this bounds it too.
   */
  adsConnect: { max: 10, windowSec: 600 },
  /** Ad accounts "Sync now", per store and user: each queues a sync per connected account. */
  adsSync: { max: 6, windowSec: 600 },
  /** The Google Ads demo connected, reset or disconnected, per user: each writes rows and queues a 90-day sync. */
  adsDemo: { max: 10, windowSec: 600 },
  /** Meta, Google Ads and AdSense reports, per store and user: each one is a few platform calls (a cached answer doesn't count). */
  adsReport: { max: 30, windowSec: 600 },
  /** The status page of a Meta data deletion request, per IP (a code is 80 random bits; this only slows guessing). */
  metaDeletionStatusIp: { max: 60, windowSec: 600 },
  /** Meta's callbacks refused (a signed_request that doesn't verify), per IP: past it they're answered 429 and no longer logged. Meta's own aren't counted. */
  metaCallbackRefusedIp: { max: 20, windowSec: 600 },
  /** WhatsApp: starting and finishing Meta's sign-up, choosing a number, entering the PIN (Meta calls each), per store. */
  waConnect: { max: 10, windowSec: 600 },
  /** WhatsApp: "Check again" (the number, webhooks and templates from Meta), per store. */
  waRefresh: { max: 6, windowSec: 600 },
  /** WhatsApp: templates submitted for Meta's review or deleted, per store. */
  waTemplateCreate: { max: 30, windowSec: 3600 },
  /** WhatsApp: test messages to the merchant's own phone, per store. */
  waTest: { max: 10, windowSec: 600 },
  /** WhatsApp: campaign audience estimates (the builder asks as filters change), per store. */
  waEstimate: { max: 120, windowSec: 600 },
  /** WhatsApp: messages a person sends from the dashboard (templates and replies), per store. */
  waSend: { max: 60, windowSec: 600 },
  /** WhatsApp: custom events a store's tools send with its event key, per key. */
  waEvents: { max: 600, windowSec: 60 },
  /** WhatsApp: the number's PIN shown, per user. */
  waPin: { max: 5, windowSec: 3600 },

  // ---- Customer Messaging (SMS) ----
  /** "Check with AWS" on the sender (a few AWS calls each), per store. */
  smsVerify: { max: 10, windowSec: 600 },
  /** Automations hub: changes to automations and channel connections, per workspace. */
  automations: { max: 120, windowSec: 600 },
  /** Verification codes AWS texts to a test number, per store (each costs a text). */
  smsVerificationCode: { max: 5, windowSec: 3600 },
  /** Codes typed in for one test number (AWS's codes are short: this stops guessing). */
  smsVerificationCheck: { max: 10, windowSec: 3600 },
  /** Test texts to the team's own numbers, per store. */
  smsTest: { max: 10, windowSec: 600 },
  /** Set up SMS: "Request sender name" (each one emails the platform owner), per store. */
  smsSenderRequest: { max: 5, windowSec: 3600 },
  /** Set up SMS: Connect, and the setup's other changes (drafts, messages, automatic texts), per store. */
  smsSetup: { max: 120, windowSec: 600 },
  /** One-off texts to a customer from the Send SMS page, per store. */
  smsManual: { max: 30, windowSec: 600 },
  /** The template editor's live preview (as the merchant types), per store. */
  smsPreview: { max: 300, windowSec: 600 },
  /** Segment and campaign estimates and rule dry runs, per store. */
  smsEstimate: { max: 120, windowSec: 600 },
  /** The /stop page's look-ups and confirmations, per IP (a code is ~59 random bits; this only slows guessing). */
  smsOptOutIp: { max: 30, windowSec: 600 },

  // ---- Staff Management ----
  /** Employee invitation page loads, per IP (a token is 256 bits; this only slows scanning). */
  joinLookupIp: { max: 60, windowSec: 600 },
  /** Account activations from an invitation, per IP and per invitation. */
  joinAcceptIp: { max: 10, windowSec: 900 },
  joinAcceptToken: { max: 5, windowSec: 3600 },
  /** Clock in/out and breaks, per employee: a person needs a handful an hour, never dozens a minute. */
  clockActions: { max: 20, windowSec: 60 },
  /** Correction requests, per employee. */
  correctionRequests: { max: 20, windowSec: 3600 },
  /** Report and payslip downloads, per user. */
  staffExports: { max: 30, windowSec: 600 },
  /**
   * Staff analytics, trends and on-screen reports, per user. Each one loads every shift in a range
   * of up to a few years; the dashboard refreshes twice a minute, so this leaves room for several
   * open tabs while stopping a script from hammering the shared database.
   */
  staffAnalytics: { max: 180, windowSec: 600 },
  /** "Sign out everywhere", per user. */
  revokeSessions: { max: 5, windowSec: 3600 },

  // ---- Email integrations (per workspace unless named otherwise) ----
  /** Connecting accounts: OAuth sign-ins started and SMTP connections saved. */
  emailConnect: { max: 20, windowSec: 3600 },
  /** "Test connection": a token refresh or an SMTP sign-in each. */
  emailTest: { max: 20, windowSec: 600 },
  /** Test emails to oneself. */
  emailTestSend: { max: 10, windowSec: 600 },
  /** "Check DNS now", per domain. */
  emailDomainCheck: { max: 6, windowSec: 300 },
  /** Sender verification codes sent, and guesses at them, per sender. */
  emailSenderCode: { max: 5, windowSec: 3600 },
  emailSenderConfirm: { max: 10, windowSec: 900 },
  /** Template previews and automation dry runs, per user. */
  emailPreview: { max: 120, windowSec: 600 },
  /** Manual retries of failed messages. */
  emailRetry: { max: 60, windowSec: 600 },
  /** POST /v1/events, per key and per IP. */
  emailIngestKey: { max: 600, windowSec: 60 },
  emailIngestIp: { max: 1200, windowSec: 60 },
  /** Unsubscribe page loads and clicks, per IP. */
  emailUnsubscribeIp: { max: 60, windowSec: 600 },

  // ---- Public ingest ----
  /** Web pixel, per IP (a storefront sends a batch per page or so). */
  pixelIp: { max: 600, windowSec: 60 },
  /** Meta's webhook verification handshake (GET), per IP. */
  waVerifyIp: { max: 30, windowSec: 60 },
  /**
   * WhatsApp webhook deliveries whose signature doesn't verify, per IP: past it they're answered 429
   * and no longer logged. Meta's own (signed) deliveries aren't counted.
   */
  waUnsignedIp: { max: 300, windowSec: 60 },
  /** Custom events sent with a key that doesn't verify, per IP. */
  waEventKeyIp: { max: 30, windowSec: 600 },
  /**
   * Password resets tried with one address's code, per address, whichever IPs they come from
   * (auth.ts, POST /auth/password/reset): codeVerifyIp alone lets guesses spread over many IPs,
   * leaving Cognito's own lockout as the only guard. As many as claimVerifyEmail allows.
   */
  resetVerifyEmail: { max: 5, windowSec: 3600 },
} as const satisfies Record<string, Limit>;

/** Fixed-window limiter. Throws 429 once more than `max` hits occur within `windowSec`. */
export async function limit(coord: Coord, key: string, policy: Limit, message = "Too many attempts. Please wait and try again.", code = "rate_limited") {
  const n = await coord.hit(key, policy.windowSec);
  // Fixed windows: the wait is at most one window, so that is what Retry-After promises.
  if (n > policy.max) throw new HttpError(429, message, code, policy.windowSec);
}
