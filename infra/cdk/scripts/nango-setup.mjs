// Create (or bring up to date) bizinsights' integrations in its Nango environment (docs/nango.md), from
// the keys bizinsights already has: its Meta app and its Google OAuth client. Every ad platform is
// connected through these three integrations (Meta Ads, Google Ads, Google AdSense).
// Nothing is printed but names, ids that are public anyway, and what changed.
//
//   node infra/cdk/scripts/nango-setup.mjs [--env production] [--providers meta,google,adsense] [--check]
//
// --check      only read: says which integrations exist, from which Nango provider, with which
//              client id, whether Nango holds the same client secret, whether Meta accepts
//              META_APP_SECRET for the Meta app, and what --apply would change. The default.
// --apply      create the missing integrations and update the ones whose client, secret or scopes
//              differ. A Meta secret Meta refuses is never sent to Nango.
//
// It reads NANGO_SECRET_KEY, META_APP_SECRET and GOOGLE_ADS_CLIENT_SECRET from the app secret
// (insights/<env>/app, `aws login` first) and the public ids from apps/aws/src/settings.ts, and sends
// the client secrets only to Nango and the Meta secret to Meta (over HTTPS, in a request body): they
// are never printed or written.
//
// Why the secret matters: bizinsights signs every Meta call with META_APP_SECRET (appsecret_proof). A
// Nango integration holding another secret or app makes tokens Meta then refuses with "Invalid
// appsecret_proof", and "Continue with Meta Ads" ends in "isn't set up correctly on bizinsights' side".
//
// The environment's callback URL (<APP_URL>/api/ads/nango/oauth-callback) and webhook URL
// (<APP_URL>/api/webhooks/nango) can only be set in Nango's dashboard: see docs/nango.md.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { metaAcceptsSecret } from "./meta-secret.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const envName = opt("--env") ?? "production";
const region = opt("--region") ?? "ap-southeast-2";
const apply = args.includes("--apply");
const providers = (opt("--providers") ?? "meta,google,adsense").split(",").map((s) => s.trim()).filter(Boolean);

/** Kept in step with packages/core/src/ads/nango.ts (NANGO_INTEGRATION, NANGO_PROVIDER_TEMPLATE). */
export const INTEGRATIONS = {
  meta: { key: "bizinsights-meta-ads", provider: "facebook", name: "bizinsights · Meta Ads" },
  google: { key: "bizinsights-google-ads", provider: "google", name: "bizinsights · Google Ads" },
  adsense: { key: "bizinsights-google-adsense", provider: "google", name: "bizinsights · Google AdSense" },
};

/** The public settings (apps/aws/src/settings.ts), as put-secrets.mjs reads them. */
function settings() {
  const text = readFileSync(fileURLToPath(new URL("../../../apps/aws/src/settings.ts", import.meta.url)), "utf8");
  const out = {};
  for (const m of text.matchAll(/^\s*"([A-Z][A-Z0-9_]*)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) out[m[1]] = JSON.parse(`"${m[2]}"`);
  return out;
}

/**
 * What each integration must hold: the client id and secret of bizinsights' own app, and the scopes
 * bizinsights reads with. Meta with a Login for Business configuration (META_CONFIG_ID) takes no
 * scope: the configuration decides, and bizinsights sends its config_id with every session. Google's
 * also ask for `openid` (who the account is, nothing else), so a disconnect
 * knows whose grant it is taking back (packages/core/src/ads/googleOAuth.ts GOOGLE_IDENTITY_SCOPE), and
 * `email`, so a sign-in that reaches no account can say which Google account was used (GOOGLE_EMAIL_SCOPE).
 */
export function wanted(provider, s, secret) {
  if (provider === "meta") return { clientId: s.META_APP_ID, clientSecret: secret.META_APP_SECRET, scopes: s.META_CONFIG_ID ? "" : "ads_read" };
  const scope = provider === "adsense" ? "https://www.googleapis.com/auth/adsense.readonly" : "https://www.googleapis.com/auth/adwords";
  return { clientId: s.GOOGLE_ADS_CLIENT_ID, clientSecret: secret.GOOGLE_ADS_CLIENT_SECRET, scopes: `${scope},openid,email` };
}

/**
 * What differs between an integration as Nango holds it (`data`, from GET /integrations/<key>?include=credentials)
 * and what it must hold. Never says a secret, only whether it matches. `fatal`: only deleting it in Nango's
 * dashboard fixes it (made from another Nango provider), so --apply leaves it.
 */
export function differences(def, data, want) {
  const cred = data.credentials ?? {};
  const problems = [];
  let fatal = false;
  if (data.provider && data.provider !== def.provider) {
    problems.push(`made from provider ${data.provider}, not ${def.provider} (delete it in Nango's dashboard and run --apply again)`);
    fatal = true;
  }
  if (cred.client_id && cred.client_id !== want.clientId) problems.push(`client id ${cred.client_id}, not ${want.clientId}`);
  if (typeof cred.client_secret === "string" && cred.client_secret !== want.clientSecret) problems.push("client secret isn't the one in the app secret");
  if (cred.scopes !== undefined && (cred.scopes ?? "") !== want.scopes) problems.push(`scopes "${cred.scopes ?? ""}", not "${want.scopes}"`);
  return { problems, fatal };
}

async function nango(key, method, path, body) {
  const res = await fetch(`https://api.nango.dev${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  const raw = execFileSync("aws", ["secretsmanager", "get-secret-value", "--secret-id", `insights/${envName}/app`, "--region", region, "--output", "json"], { encoding: "utf8" });
  const secret = JSON.parse(JSON.parse(raw).SecretString);
  if (!secret.NANGO_SECRET_KEY) throw new Error("NANGO_SECRET_KEY isn't in the app secret yet: node infra/cdk/scripts/put-secrets.mjs --set NANGO_SECRET_KEY");
  const s = settings();
  console.log(`Nango environment of insights/${envName}/app (${apply ? "apply" : "check only"}):`);
  for (const p of providers) {
    const def = INTEGRATIONS[p];
    if (!def) throw new Error(`Unknown platform ${p} (meta, adsense, google)`);
    const want = wanted(p, s, secret);
    if (!want.clientId || !want.clientSecret) {
      console.log(`  ${def.key}: SKIPPED, ${p === "meta" ? "META_APP_ID/META_APP_SECRET" : "GOOGLE_ADS_CLIENT_ID/GOOGLE_ADS_CLIENT_SECRET"} not set`);
      continue;
    }
    // The Meta secret every call is signed with must be the app's own: never copied to Nango when Meta refuses it.
    let secretRefused = false;
    if (p === "meta") {
      const { accepted, detail } = await metaAcceptsSecret(want.clientId, want.clientSecret, s.META_API_VERSION || undefined);
      secretRefused = accepted === false;
      console.log(
        accepted === true ? `  Meta accepts META_APP_SECRET for app ${want.clientId}`
        : accepted === false ? `  Meta REFUSES META_APP_SECRET for app ${want.clientId} (${detail}): copy the App secret (developers.facebook.com → App settings → Basic), run node infra/cdk/scripts/put-secrets.mjs --env ${envName} --set META_APP_SECRET, restart the functions, then run this with --apply`
        : `  Meta didn't answer whether META_APP_SECRET is app ${want.clientId}'s (${detail}): run this again`,
      );
    }
    const got = await nango(secret.NANGO_SECRET_KEY, "GET", `/integrations/${def.key}?include=credentials`);
    if (got.status === 401 || got.status === 403) throw new Error(`Nango refused the key (${got.status}): check NANGO_SECRET_KEY`);
    const body = { unique_key: def.key, provider: def.provider, display_name: def.name, credentials: { type: "OAUTH2", client_id: want.clientId, client_secret: want.clientSecret, scopes: want.scopes } };
    if (got.status === 404) {
      if (!apply || secretRefused) {
        console.log(`  ${def.key}: MISSING (${secretRefused ? "not created while Meta refuses the secret" : "would be created"} from provider ${def.provider}, client ${want.clientId})`);
        continue;
      }
      const made = await nango(secret.NANGO_SECRET_KEY, "POST", "/integrations", body);
      console.log(`  ${def.key}: ${made.status < 300 ? "created" : `NOT created (HTTP ${made.status}: ${made.json?.error?.code ?? "?"})`}`);
      continue;
    }
    const data = got.json?.data ?? {};
    const { problems, fatal } = differences(def, data, want);
    if (typeof data.credentials?.client_secret !== "string") console.log(`  ${def.key}: Nango didn't show its client secret, so it wasn't compared`);
    if (!problems.length) {
      console.log(`  ${def.key}: ok (provider ${data.provider ?? def.provider}, client ${want.clientId})`);
      continue;
    }
    if (!apply || fatal || secretRefused) {
      console.log(`  ${def.key}: DIFFERS: ${problems.join("; ")}`);
      continue;
    }
    const { unique_key: _key, provider: _provider, ...patch } = body;
    const updated = await nango(secret.NANGO_SECRET_KEY, "PATCH", `/integrations/${def.key}`, patch);
    console.log(`  ${def.key}: ${updated.status < 300 ? "updated" : `NOT updated (HTTP ${updated.status}: ${updated.json?.error?.code ?? "?"})`} (${problems.join("; ")})`);
  }
  console.log("Then in Nango's dashboard (Environment Settings): Callback URL and Webhook URL, as docs/nango.md says.");
  console.log("bizinsights asks Nango which integrations exist every 5 minutes: a platform made or fixed here shows its Connect button within that.");
}

// Run as a script. Imported by tests (vitest sets VITEST), it only provides the definitions above.
if (!process.env.VITEST) await main();
