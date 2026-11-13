#!/usr/bin/env node
// E2E only: a stand-in for Google's sign-in, which can't run in a test. The app's own sign-in
// (apps/api/src/localAuth.ts) is pointed at it with GOOGLE_SIGNIN_ENDPOINT, a development-only
// setting production refuses to start with. It serves what the app uses of Google:
//
//   GET  /o/oauth2/v2/auth   remembers the PKCE challenge and nonce, "signs in" a made-up person and
//                            sends the browser back to redirect_uri with a code (or error=access_denied)
//   POST /token              checks the client's id and secret, the code, redirect_uri and the PKCE
//                            verifier, then answers with an ID token shaped as Google's
//   GET  /oauth2/v3/certs    the key that signs those tokens (made new at every start)
//
// Usage: node fake-google.mjs <port> <clientId> <clientSecret>
import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { URL, URLSearchParams } from "node:url";

const [port, clientId, clientSecret] = process.argv.slice(2);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = randomUUID();
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };

const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function jwt(claims) {
  const head = b64u({ alg: "RS256", typ: "JWT", kid });
  const body = b64u(claims);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const pending = new Map();
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === "GET" && url.pathname === "/o/oauth2/v2/auth") {
    const q = url.searchParams;
    const back = new URL(q.get("redirect_uri"));
    back.searchParams.set("state", q.get("state") ?? "");
    if (q.get("client_id") !== clientId) return send(res, 400, { error: "invalid_client" });
    if (q.get("deny") === "1" || q.get("login_hint") === "deny") {
      back.searchParams.set("error", "access_denied");
      return send(res, 302, "", { location: back.toString() });
    }
    // The person "chooses an account" on a page, so a test can decide who signs in (or cancels).
    if (!q.has("as")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>Google (test)</title><h1>Sign in with Google (test)</h1>
<form method="get">
<label>Email <input name="as" type="email" required></label> <button>Continue</button></form>
<a href="${back.toString()}&error=access_denied">Cancel</a>
<script>document.forms[0].onsubmit=(e)=>{e.preventDefault();location.href=location.pathname+location.search+"&as="+encodeURIComponent(document.querySelector("[name=as]").value)}</script>`);
    }
    const code = randomUUID();
    pending.set(code, { email: q.get("as"), challenge: q.get("code_challenge"), nonce: q.get("nonce"), redirectUri: q.get("redirect_uri") });
    back.searchParams.set("code", code);
    return send(res, 302, "", { location: back.toString() });
  }
  if (req.method === "POST" && url.pathname === "/token") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) return send(res, 401, { error: "invalid_client" });
    const p = pending.get(form.get("code"));
    pending.delete(form.get("code"));
    const verifierOk = p && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === p.challenge;
    if (!p || !verifierOk || form.get("redirect_uri") !== p.redirectUri) return send(res, 400, { error: "invalid_grant" });
    const now = Math.floor(Date.now() / 1000);
    // One Google account per address: the same person every time they "choose" it.
    const sub = createHash("sha256").update(p.email.toLowerCase()).digest("hex").slice(0, 16);
    return send(res, 200, {
      id_token: jwt({
        iss: "https://accounts.google.com",
        aud: clientId,
        azp: clientId,
        sub,
        iat: now,
        exp: now + 3600,
        nonce: p.nonce,
        email: p.email,
        email_verified: true,
        name: "Social Person",
        // A picture only for "pic-" addresses: a test that wants one answers Google's image host itself.
        ...(p.email.startsWith("pic-") && { picture: `https://lh3.googleusercontent.com/a/e2e-${sub}=s96-c` }),
      }),
      access_token: `fake-google-access-${randomUUID()}`,
      expires_in: 3600,
      token_type: "Bearer",
      scope: "openid email profile",
    });
  }
  if (req.method === "GET" && url.pathname === "/oauth2/v3/certs") return send(res, 200, { keys: [jwk] });
  send(res, 404, { error: "not_found" });
}).listen(Number(port), "127.0.0.1");
