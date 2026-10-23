#!/usr/bin/env node
// E2E only: a stand-in for the user pool's managed login (its OAuth domain) in front of Google,
// which can't run in a test. It implements what the app uses of it:
//
//   GET  /oauth2/authorize  remembers the PKCE challenge and nonce, "signs in" a made-up person and
//                           sends the browser back to redirect_uri with a code (or ?deny=1: access_denied)
//   POST /oauth2/token      checks the client's Basic credentials, the code, redirect_uri and the PKCE
//                           verifier, then answers with Cognito-shaped tokens
//   GET  /logout            back to logout_uri
//
// The ID token is signed with the Cognito emulator's key (published with cognito-local, which is why
// production refuses an emulator), so the app verifies it against the emulator's JWKS exactly as
// it verifies Cognito's. Usage: node fake-managed-login.mjs <port> <issuer> <clientId> <clientSecret>
import { createHash, createSign, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { URL, URLSearchParams } from "node:url";
import { join } from "node:path";

const [port, issuer, clientId, clientSecret] = process.argv.slice(2);

/** cognito-local's signing key, from the npx cache the emulator was started from. */
function emulatorKey() {
  const cache = join(execSync("npm config get cache").toString().trim(), "_npx");
  for (const dir of existsSync(cache) ? readdirSync(cache) : []) {
    const f = join(cache, dir, "node_modules/cognito-local/lib/keys/cognitoLocal.private.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  }
  throw new Error("cognito-local's key not found in the npx cache: start the emulator first");
}
/** Read when first needed: the emulator may still be installing when this starts. */
let key;

const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function jwt(claims) {
  key ??= emulatorKey();
  const head = b64u({ alg: "RS256", typ: "JWT", kid: key.jwk.kid });
  const body = b64u(claims);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key.pem).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const pending = new Map();
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === "GET" && url.pathname === "/oauth2/authorize") {
    const q = url.searchParams;
    const back = new URL(q.get("redirect_uri"));
    back.searchParams.set("state", q.get("state") ?? "");
    if (url.searchParams.get("deny") === "1" || q.get("login_hint") === "deny") {
      back.searchParams.set("error", "access_denied");
      return send(res, 302, "", { location: back.toString() });
    }
    // The person "chooses an account" on a page, so a test can decide who signs in (or cancels).
    if (!url.searchParams.has("as")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>${q.get("identity_provider")} (test)</title><h1>Sign in with ${q.get("identity_provider")} (test)</h1>
<form method="get">
<label>Email <input name="as" type="email" required></label> <button>Continue</button></form>
<a href="${back.toString()}&error=access_denied">Cancel</a>
<script>document.forms[0].onsubmit=(e)=>{e.preventDefault();location.href=location.pathname+location.search+"&as="+encodeURIComponent(document.querySelector("[name=as]").value)}</script>`);
    }
    const code = randomUUID();
    pending.set(code, {
      email: url.searchParams.get("as"),
      provider: q.get("identity_provider"),
      challenge: q.get("code_challenge"),
      nonce: q.get("nonce"),
      redirectUri: q.get("redirect_uri"),
    });
    back.searchParams.set("code", code);
    return send(res, 302, "", { location: back.toString() });
  }
  if (req.method === "POST" && url.pathname === "/oauth2/token") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    if (req.headers.authorization !== expected) return send(res, 401, { error: "invalid_client" });
    const p = pending.get(form.get("code"));
    pending.delete(form.get("code"));
    const verifierOk = p && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === p.challenge;
    if (!p || !verifierOk || form.get("redirect_uri") !== p.redirectUri) return send(res, 400, { error: "invalid_grant" });
    const now = Math.floor(Date.now() / 1000);
    const userId = createHash("sha256").update(p.email).digest("hex").slice(0, 16);
    const prefix = p.provider.toLowerCase();
    const sub = randomUUID();
    return send(res, 200, {
      id_token: jwt({
        sub,
        aud: clientId,
        iss: issuer,
        token_use: "id",
        auth_time: now,
        iat: now,
        exp: now + 3600,
        nonce: p.nonce,
        email: p.email,
        email_verified: "true",
        name: "Social Person",
        // Google's picture (mapped by the pool) only for "pic-" addresses: a test that wants one answers Google's image host itself.
        ...(p.email.startsWith("pic-") && { picture: `https://lh3.googleusercontent.com/a/e2e-${userId}=s96-c` }),
        "cognito:username": `${prefix}_${userId}`,
        identities: [{ userId, providerName: p.provider, providerType: p.provider, primary: "true" }],
      }),
      access_token: jwt({ sub, client_id: clientId, iss: issuer, token_use: "access", iat: now, exp: now + 3600 }),
      refresh_token: `fake-refresh-${randomUUID()}`,
      expires_in: 3600,
      token_type: "Bearer",
    });
  }
  if (req.method === "GET" && url.pathname === "/logout") return send(res, 302, "", { location: url.searchParams.get("logout_uri") ?? "/" });
  send(res, 404, { error: "not_found" });
}).listen(Number(port), "127.0.0.1");
