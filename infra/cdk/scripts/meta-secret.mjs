// Whether Meta takes a value as an app's secret, for the scripts that store or copy it
// (put-secrets.mjs). bizinsights signs every Meta call with the secret
// (appsecret_proof), so a value of the right shape that isn't the app's breaks every Meta call.
import { URLSearchParams } from "node:url";

/**
 * Whether Meta takes `appSecret` as the secret of app `appId`: an app token (client_credentials) comes
 * back. `accepted` is null when Meta didn't answer; `detail` is Meta's own refusal (HTTP status, type,
 * code, message), never the secret. The secret goes to Meta only, in the request body.
 */
export async function metaAcceptsSecret(appId, appSecret, version = "v26.0", fetchImpl = fetch) {
  const res = await fetchImpl(`https://graph.facebook.com/${version}/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: "client_credentials" }).toString(),
  }).catch((err) => ({ failed: err instanceof Error ? err.message : String(err) }));
  if ("failed" in res) return { accepted: null, detail: `no answer: ${res.failed}` };
  const json = await res.json().catch(() => ({}));
  if (res.ok && typeof json.access_token === "string") return { accepted: true, detail: null };
  const e = json?.error ?? {};
  const said = [`HTTP ${res.status}`, e.type, e.code !== undefined ? `code ${e.code}` : null, e.error_subcode !== undefined ? `subcode ${e.error_subcode}` : null, e.message]
    .filter(Boolean)
    .join(", ")
    .split(appSecret)
    .join("***");
  return { accepted: res.status >= 500 ? null : false, detail: said };
}
