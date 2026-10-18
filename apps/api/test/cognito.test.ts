import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import type { FetchLike } from "@app/core";
import { cognitoAuth, CognitoError, CognitoUnavailableError, type CognitoConfig } from "../src/cognito.js";
import { newSession, readSession, signSession } from "../src/session.js";

/**
 * The real Cognito client against a scripted network: what goes over the wire (targets, SECRET_HASH,
 * SigV4, the OAuth token request) and how each kind of answer is classified. ID tokens are signed
 * with a real RSA key and checked exactly as in production.
 */

const CFG: CognitoConfig = {
  region: "ap-southeast-2",
  userPoolId: "ap-southeast-2_TestPool",
  clientId: "client123",
  clientSecret: "s3cret",
  endpoint: "https://cognito-idp.ap-southeast-2.amazonaws.com/",
  issuer: "https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_TestPool",
  jwksUrl: "https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_TestPool/.well-known/jwks.json",
  domain: "https://auth.example.com",
  admin: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
  refreshRotation: false,
};

type Seen = { url: string; headers: Headers; body: string };
function network(answer: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const s = { url: req.url, headers: req.headers, body: await req.text() };
    seen.push(s);
    return answer(s);
  };
  return { seen, fetchImpl };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const target = (s: Seen) => s.headers.get("x-amz-target")?.replace("AWSCognitoIdentityProviderService.", "");
const secretHash = (username: string) => createHmac("sha256", CFG.clientSecret).update(username + CFG.clientId).digest("base64");

describe("the user-pool API", () => {
  it("signs in with USER_PASSWORD_AUTH and the app client's SECRET_HASH, unsigned (no IAM)", async () => {
    const net = network(() => json({ AuthenticationResult: { IdToken: "id", AccessToken: "at", RefreshToken: "rt", ExpiresIn: 3600 } }));
    const r = await cognitoAuth(CFG, net.fetchImpl).passwordSignIn("a@x.com", "pw");
    expect(r).toEqual({ tokens: { idToken: "id", accessToken: "at", refreshToken: "rt", expiresIn: 3600 } });
    const [req] = net.seen;
    expect(req!.url).toBe(CFG.endpoint);
    expect(target(req!)).toBe("InitiateAuth");
    expect(req!.headers.get("content-type")).toBe("application/x-amz-json-1.1");
    expect(req!.headers.get("authorization")).toBeNull();
    expect(JSON.parse(req!.body)).toEqual({
      ClientId: "client123",
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: "a@x.com", PASSWORD: "pw", SECRET_HASH: secretHash("a@x.com") },
    });
  });

  it("refreshes with the Cognito user name in SECRET_HASH, not the email", async () => {
    const net = network(() => json({ AuthenticationResult: { IdToken: "id", AccessToken: "at", ExpiresIn: 3600 } }));
    await cognitoAuth(CFG, net.fetchImpl).refresh("the-rt", "google_123");
    expect(JSON.parse(net.seen[0]!.body).AuthParameters).toEqual({ REFRESH_TOKEN: "the-rt", SECRET_HASH: secretHash("google_123") });
  });

  it("uses GetTokensFromRefreshToken (with the client secret) when rotation is on", async () => {
    const net = network(() => json({ AuthenticationResult: { IdToken: "id", AccessToken: "at", RefreshToken: "rt2", ExpiresIn: 3600 } }));
    const t = await cognitoAuth({ ...CFG, refreshRotation: true }, net.fetchImpl).refresh("rt1", "u");
    expect(target(net.seen[0]!)).toBe("GetTokensFromRefreshToken");
    expect(JSON.parse(net.seen[0]!.body)).toEqual({ ClientId: "client123", RefreshToken: "rt1", ClientSecret: "s3cret" });
    expect(t.refreshToken).toBe("rt2");
  });

  it("signs administrator calls with SigV4 for cognito-idp in the pool's region", async () => {
    const net = network(() => json({ Username: "uuid-1", UserAttributes: [{ Name: "sub", Value: "uuid-1" }, { Name: "email", Value: "a@x.com" }, { Name: "email_verified", Value: "true" }], Enabled: true, UserStatus: "CONFIRMED" }));
    const u = await cognitoAuth(CFG, net.fetchImpl).adminGetUser("a@x.com");
    expect(u).toEqual({ username: "uuid-1", sub: "uuid-1", email: "a@x.com", emailVerified: true, enabled: true, status: "CONFIRMED" });
    const auth = net.seen[0]!.headers.get("authorization")!;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-southeast-2\/cognito-idp\/aws4_request, SignedHeaders=[^,]*x-amz-target[^,]*, Signature=[0-9a-f]{64}$/);
    expect(net.seen[0]!.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(JSON.parse(net.seen[0]!.body)).toEqual({ UserPoolId: CFG.userPoolId, Username: "a@x.com" });
  });

  it("refuses administrator calls without credentials, rather than sending them unsigned", async () => {
    const net = network(() => json({}));
    await expect(cognitoAuth({ ...CFG, admin: null }, net.fetchImpl).adminDeleteUser("u")).rejects.toThrow(/admin credentials/);
    expect(net.seen).toHaveLength(0);
  });

  it("creates users without Cognito's invitation email, confirmed with a permanent password", async () => {
    const net = network((s) => (target(s) === "AdminCreateUser" ? json({ User: { Username: "uuid-2", Attributes: [{ Name: "sub", Value: "uuid-2" }, { Name: "email", Value: "b@x.com" }], UserStatus: "FORCE_CHANGE_PASSWORD" } }) : json({})));
    const u = await cognitoAuth(CFG, net.fetchImpl).adminCreateUser({ email: "b@x.com", emailVerified: true, name: "Bee", password: "their-password" });
    expect(u.status).toBe("CONFIRMED");
    expect(net.seen.map(target)).toEqual(["AdminCreateUser", "AdminSetUserPassword"]);
    expect(JSON.parse(net.seen[0]!.body)).toMatchObject({ MessageAction: "SUPPRESS", Username: "b@x.com" });
    expect(JSON.parse(net.seen[1]!.body)).toEqual({ UserPoolId: CFG.userPoolId, Username: "uuid-2", Password: "their-password", Permanent: true });
  });

  it("deletes a user it created when the password is refused, and reports the refusal", async () => {
    const net = network((s) =>
      target(s) === "AdminCreateUser"
        ? json({ User: { Username: "uuid-3", Attributes: [{ Name: "sub", Value: "uuid-3" }] } })
        : target(s) === "AdminSetUserPassword"
          ? json({ __type: "InvalidPasswordException", message: "Password did not conform with policy" }, 400)
          : json({}),
    );
    await expect(cognitoAuth(CFG, net.fetchImpl).adminCreateUser({ email: "c@x.com", emailVerified: true, password: "short" })).rejects.toMatchObject({ code: "InvalidPasswordException" });
    expect(net.seen.map(target)).toEqual(["AdminCreateUser", "AdminSetUserPassword", "AdminDeleteUser"]);
  });

  it("tells a refusal apart from an outage", async () => {
    const refusal = network(() => json({ __type: "com.amazonaws.cognito.identity.idp.model#NotAuthorizedException", message: "Incorrect username or password." }, 400));
    await expect(cognitoAuth(CFG, refusal.fetchImpl).passwordSignIn("a@x.com", "x")).rejects.toEqual(new CognitoError("NotAuthorizedException", "Incorrect username or password."));
    const throttled = network(() => json({ __type: "TooManyRequestsException", message: "Rate exceeded" }, 400));
    await expect(cognitoAuth(CFG, throttled.fetchImpl).passwordSignIn("a@x.com", "x")).rejects.toMatchObject({ code: "TooManyRequestsException" });
    for (const down of [() => json({ message: "oops" }, 500), () => json({ __type: "InternalErrorException" }, 400), () => Promise.reject(new TypeError("fetch failed"))]) {
      const net = network(down as () => Response);
      await expect(cognitoAuth(CFG, net.fetchImpl).passwordSignIn("a@x.com", "x")).rejects.toBeInstanceOf(CognitoUnavailableError);
    }
    const missing = network(() => json({ __type: "UserNotFoundException" }, 400));
    expect(await cognitoAuth(CFG, missing.fetchImpl).adminGetUser("nobody@x.com")).toBeNull();
  });
});

describe("managed login (OAuth)", () => {
  it("sends the browser straight to the provider with PKCE and a nonce", () => {
    const url = new URL(cognitoAuth(CFG).authorizeUrl({ provider: "Google", redirectUri: "https://app.example.com/auth/callback", state: "st", codeChallenge: "ch", nonce: "no" }));
    expect(url.origin + url.pathname).toBe("https://auth.example.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client123",
      redirect_uri: "https://app.example.com/auth/callback",
      identity_provider: "Google",
      scope: "openid email profile",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      nonce: "no",
    });
  });

  it("exchanges the code with the client secret (Basic) and the PKCE verifier", async () => {
    const net = network(() => json({ id_token: "id", access_token: "at", refresh_token: "rt", expires_in: 3600 }));
    const t = await cognitoAuth(CFG, net.fetchImpl).exchangeCode({ code: "c0de", redirectUri: "https://app.example.com/auth/callback", codeVerifier: "v3rifier" });
    expect(t).toEqual({ idToken: "id", accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
    const req = net.seen[0]!;
    expect(req.url).toBe("https://auth.example.com/oauth2/token");
    expect(req.headers.get("authorization")).toBe(`Basic ${Buffer.from("client123:s3cret").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({
      client_id: "client123",
      grant_type: "authorization_code",
      code: "c0de",
      redirect_uri: "https://app.example.com/auth/callback",
      code_verifier: "v3rifier",
    });
    const bad = network(() => json({ error: "invalid_grant" }, 400));
    await expect(cognitoAuth(CFG, bad.fetchImpl).exchangeCode({ code: "x", redirectUri: "r", codeVerifier: "v" })).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };

describe("ID token verification", () => {
  const keys = network((s) => (s.url === CFG.jwksUrl ? json({ keys: [jwk] }) : json({}, 404)));
  const auth = cognitoAuth(CFG, keys.fetchImpl);
  const now = Math.floor(Date.now() / 1000);
  const good: JWTPayload & Record<string, unknown> = {
    sub: "sub-1",
    token_use: "id",
    "cognito:username": "google_42",
    email: "Person@Gmail.com",
    email_verified: "true",
    given_name: "Ada",
    family_name: "L",
    auth_time: now - 5,
    nonce: "n1",
    identities: [{ providerName: "Google", providerType: "Google", userId: "42" }],
  };
  const sign = (claims: JWTPayload, opts: { iss?: string; aud?: string; exp?: number; alg?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? CFG.issuer)
      .setAudience(opts.aud ?? CFG.clientId)
      .setIssuedAt(now)
      .setExpirationTime(opts.exp ?? now + 3600)
      .sign(privateKey);

  it("accepts the pool's token and reads it the way the app needs it", async () => {
    expect(await auth.verifyIdToken(await sign(good), { nonce: "n1" })).toEqual({
      sub: "sub-1",
      username: "google_42",
      email: "person@gmail.com",
      emailVerified: true,
      name: "Ada L",
      method: "google",
      authTime: now - 5,
    });
  });

  it("rejects another pool, another app client, an access token, a stale token and a replayed nonce", async () => {
    const bad = [
      await sign(good, { iss: "https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_Other" }),
      await sign(good, { aud: "someone-elses-client" }),
      await sign({ ...good, token_use: "access" }),
      await sign(good, { exp: now - 10 }),
    ];
    for (const t of bad) await expect(auth.verifyIdToken(t)).rejects.toMatchObject({ code: "InvalidToken" });
    await expect(auth.verifyIdToken(await sign(good), { nonce: "another" })).rejects.toMatchObject({ code: "InvalidToken" });
    await expect(auth.verifyIdToken("not.a.jwt")).rejects.toMatchObject({ code: "InvalidToken" });
  });

  it("rejects a token signed with a key that isn't the pool's, or not signed at all", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT(good).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(CFG.issuer).setAudience(CFG.clientId).setExpirationTime(now + 60).sign(other.privateKey);
    await expect(auth.verifyIdToken(forged)).rejects.toMatchObject({ code: "InvalidToken" });
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "none", kid: "k1" })}.${enc({ ...good, iss: CFG.issuer, aud: CFG.clientId, exp: now + 60 })}.`;
    await expect(auth.verifyIdToken(unsigned)).rejects.toMatchObject({ code: "InvalidToken" });
  });

  it("calls unreachable signing keys an outage, not a bad token", async () => {
    const down = cognitoAuth(CFG, network(() => json({}, 503)).fetchImpl);
    await expect(down.verifyIdToken(await sign(good))).rejects.toBeInstanceOf(CognitoUnavailableError);
  });
});

describe("our session cookie", () => {
  it("is tamper-evident and expires", () => {
    const s = newSession({ userId: "u1", sub: "s1", username: "s1", method: "password", authTime: 1 });
    const cookie = signSession(s);
    expect(readSession(cookie)).toEqual(s);
    const [payload, sig] = cookie.split(".");
    const other = Buffer.from(JSON.stringify({ ...s, uid: "u2" })).toString("base64url");
    expect(readSession(`${other}.${sig}`)).toBeNull();
    expect(readSession(`${payload}.${sig!.slice(0, -2)}xx`)).toBeNull();
    expect(readSession(cookie, s.exp + 1)).toBeNull();
    expect(readSession(undefined)).toBeNull();
  });
});
