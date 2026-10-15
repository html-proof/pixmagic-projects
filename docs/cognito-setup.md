# Sign-in: Amazon Cognito

Insights signs people in with an Amazon Cognito user pool: email and password (with emailed codes
for sign-up and password resets), Continue with Google, and optionally a passwordless emailed
code (Sign in with Apple was removed on 2026-10-16). It replaced Firebase Authentication; this page
covers how it works, how to set it up, and how existing accounts move over.

## How it works

```
browser ──► /api/auth/* (API)    ──► Cognito user-pool API          (sign-up, sign-in, codes, passwords)
   │                         └─────► <domain>/oauth2/token          (Google: code + PKCE)
   └──► <domain>/oauth2/authorize ──► Google ──► /auth/callback (page) ──► /api/auth/oauth/callback
```

- **The API does all of it** (`apps/api/src/cognito.ts`, plain HTTPS, no AWS SDK). The browser
  never talks to Cognito and never holds a Cognito token.
- **Our session**: once the API has verified Cognito's ID token (RS256 signature against the
  pool's JWKS, issuer, audience = our app client, `token_use`, expiry, and the nonce for OAuth), it
  sets `__session` (an HMAC-signed, httpOnly, SameSite=Lax, Secure cookie, 5 days) and
  `__session_rt` (the Cognito refresh token, AES-GCM encrypted with `TOKEN_ENCRYPTION_KEYS`, sent
  to `/api` only). Each request costs one HMAC; every 10 minutes the refresh token is spent with
  Cognito, so a user disabled or deleted there, or signed out everywhere, loses the session.
  `apps/api/src/session.ts`.
- **Accounts**: `users.id` never changes. Each Cognito user (password, Google) is linked to
  it in `auth_identities` (provider, Cognito `sub`, user name, method). Several identities can point
  at one user: a Google sign-in links to the existing account with the same address only when Google
  has verified it (`apps/api/src/identity.ts`). Never on an unverified address.
- **Tenancy is unchanged**: a sign-in says who someone is; workspaces, roles and permissions stay in
  our database (`requireWorkspace`, Postgres RLS).
- **The confidential app client's secret** signs every user-pool call (`SECRET_HASH`). The API
  function's own role, which may make only five admin calls on this pool (create, get, set password,
  delete, sign out everywhere), signs the admin calls with SigV4. No access keys anywhere.
- **Audit**: `auth_events` records account-level changes (account created, identity linked, account
  moved from Firebase, password reset/changed, email changed or verified, signed out everywhere,
  account deleted).

### Routes

| Route | What |
| --- | --- |
| `GET /api/auth/config` | which "Continue with ..." buttons work; whether emailed-code sign-in is on |
| `POST /api/auth/signup`, `/signup/confirm`, `/signup/resend` | create an account; confirm the emailed code |
| `POST /api/auth/login` | email + password (moves a Firebase account on its first sign-in) |
| `POST /api/auth/password/forgot`, `/password/reset` | reset code by email; new password |
| `POST /api/auth/otp/start`, `/otp/verify` | passwordless code (only with `COGNITO_EMAIL_OTP=1`) |
| `GET /api/auth/oauth/google/start` | to Google, with state, PKCE and a nonce |
| `POST /api/auth/oauth/callback` | what the provider sent back (from the `/auth/callback` page) |
| `POST /api/auth/logout`, `/logout-all` | this browser; every device |
| `GET /api/auth/session`, `/api/auth/whoami`, `/api/me` | the session |
| `GET /api/auth/account`, `POST /api/auth/account/{password,email,email/confirm,verify-email/send,verify-email,delete}` | Settings → Security |

Every POST that signs in or sends an email must come from the app's origin (login CSRF), and is
rate limited per IP and per address (`apps/api/src/rateLimit.ts`); Cognito throttles and locks out
on top. Answers never say whether an account exists, except "that email already has an account" on
sign-up.

## 1. The AWS side

Everything is in [`infra/aws/cognito.yaml`](../infra/aws/cognito.yaml): the user pool (Essentials
plan: 10,000 monthly active users free), its OAuth domain, Google when its credentials are given, the
app client, and a Secrets Manager secret holding the app client's secret. The CDK app includes it as
the `InsightsAuth-<env>` stack ([`infra/cdk/lib/auth-stack.ts`](../infra/cdk/lib/auth-stack.ts)),
deployed with everything else ([aws-deployment.md](aws-deployment.md)), with the app's address
(CloudFront's) and the domain prefix (`cognitoDomainPrefix` in `infra/cdk/lib/config.ts`). The same
stack lets the API function's role make the pool's admin calls, and writes the runtime parameter
(`/insights/<env>/runtime`) that gives the functions `COGNITO_REGION`, `COGNITO_USER_POOL_ID`,
`COGNITO_CLIENT_ID`, `COGNITO_DOMAIN` and `COGNITO_IDENTITY_PROVIDERS`.

```bash
aws cloudformation describe-stacks --stack-name InsightsAuth-production --region ap-southeast-2 --query "Stacks[0].Outputs"
```

`ProviderRedirectUri` among the outputs is what Google needs below.

Emails: by default Cognito sends codes from `no-reply@verificationemail.com`, limited to 50 a day.
That is enough to start. For more, and for the passwordless code, verify a domain in SES in the same
region, request production access, and pass `SesFromEmail` and `SesIdentityArn` to the template
(`parameters` in `infra/cdk/lib/auth-stack.ts`).

## 2. Google

In Google Cloud (project saas-89329 has the client Firebase used; a new "Web application" OAuth
client works as well):

1. APIs & Services → Credentials → the OAuth client → **Authorized redirect URIs**: add the stack's
   `ProviderRedirectUri` (`https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse`).
   **Authorized JavaScript origins**: add `https://<prefix>.auth.<region>.amazoncognito.com`.
2. OAuth consent screen: add `amazoncognito.com` to Authorized domains.
3. Put the client secret in the app secret: `node infra/cdk/scripts/put-secrets.mjs --set
   GOOGLE_SIGNIN_CLIENT_SECRET` (CloudFormation reads it from there at deploy time; it is never in
   the template). Set the client id as the GitHub variable `GOOGLE_SIGNIN_CLIENT_ID` (Settings →
   Environments → `production`) and deploy: the Deploy to AWS workflow passes it as
   `-c googleClientId=...`, and `COGNITO_IDENTITY_PROVIDERS` becomes `Google`.

## 3. The app

Nothing to set by hand: the runtime parameter carries the pool's ids and domain, the API function
reads `COGNITO_CLIENT_SECRET` from the stack's Secrets Manager secret at cold start, and its role
signs the admin calls (`apps/aws/src/secrets.ts`, `apps/aws/src/index.ts`). `COGNITO_EMAIL_OTP=1`
goes in `APP_SETTINGS` (`apps/aws/src/settings.ts`) only once SES is set up. The web build needs
nothing: every environment uses the same UI build.

## 4. Moving existing accounts from Firebase

Firebase stores passwords with its own modified scrypt, which Cognito's password-hash import does
not accept (it takes standard scrypt, bcrypt, Argon2id and PBKDF2). So passwords move one person at a
time, and nobody has to do anything:

- **Password accounts**: the first sign-in after the switch fails in Cognito (no such user), so the
  API asks Firebase once whether that email and password are right (`accounts:signInWithPassword`
  with the project's public web API key, `LEGACY_FIREBASE_API_KEY`). If they are, it creates the
  Cognito user with that same password and signs them in. Their `users.id`, workspaces and stores are
  untouched: the new identity is linked through the Firebase uid. Firebase allowed 6-character
  passwords; for those, Cognito can't take the password, so a reset code is emailed instead and the
  sign-in page says so.
- **Google accounts**: "Continue with Google" creates a Google user in the pool, and the API links
  it to the existing account by its Google-verified address.
- **Accounts that only used emailed codes or links**, and anyone who never signs in during the
  window: "Forgot password?" creates their Cognito user (no email to them, random password) and
  Cognito emails a reset code. Proving the inbox gets them back into the same `users.id`.
- **Apple accounts**: Apple was never switched on in production Firebase, so there are none (and
  Insights no longer offers Apple sign-in; "Forgot password?" would move one).

Nothing is merged on an unverified address, a Firebase account is asked about only while it has no
Cognito user, and every step is recorded in `auth_events`.

### Before the switch: the dry run

With the repo-root `.env` holding the owner-role `DATABASE_URL`, and (optionally)
`FIREBASE_SERVICE_ACCOUNT_B64` and the `COGNITO_*` settings with admin keys:

```bash
pnpm --filter @app/api ops:cognito-plan
```

It writes `ops-reports/plan-<time>.md` (every user, how they will reach Cognito, and anything to look
at first) and `ops-reports/snapshot-<time>.json` (who belongs to which workspace with which role, every
employee link). It only reads. Keep the snapshot.

### The switch

It happens at the cutover to AWS ([aws-deployment.md](aws-deployment.md), "Cutover"), which signs in
with Cognito only:

1. The data is copied in with `infra/cdk/scripts/migrate-data.mjs`, which backs the source up first
   and applies the migrations, `20261016000000_cognito_identities` included.
2. `LEGACY_FIREBASE_API_KEY` is set (`apps/aws/src/settings.ts`), and sections 1-3 are done.
3. Everyone signed in before is signed out once (the Firebase session cookie isn't ours any more) and
   signs in again, which is what moves their account.
4. Smoke-test: create an account, confirm the code, sign out, sign in; sign in with an existing
   (Firebase) account's password; Continue with Google; Forgot password.

### After the switch: the proof

```bash
$env:OPS_SNAPSHOT = "ops-reports/snapshot-<time>.json"
```

```bash
pnpm --filter @app/api ops:cognito-verify
```

It fails, and lists the differences, if any user from the snapshot is gone or has different
workspaces, roles or employee records; it also re-runs the plan, so `on_cognito` shows how many
accounts have moved.

### Rollback

Rolling back the cutover returns sign-in to the old deployment, which still uses Firebase, until it
is retired ([aws-deployment.md](aws-deployment.md#retiring-the-old-cloudflare-deployment)). Firebase still has every account and `users.firebase_uid` still
points at it, so everyone can sign in the old way again (accounts created on Cognito in between have
no Firebase account: they would need to sign up again on Firebase). The migration needs no undo:
the old version ignores the new tables and columns.

### Ending the migration window

When the plan shows (nearly) everyone `on_cognito`, clear `LEGACY_FIREBASE_API_KEY` in `apps/aws/src/settings.ts` and merge to `main`. From
then on Firebase is never asked anything; those who hadn't moved use "Forgot password?". Then the
Firebase project's Authentication can be switched off (keep it a while for rollback). `users.firebase_uid`
can stay: it is what "Forgot password?" recognises an old account by.

## 5. Local development and tests

The local server (`pnpm --filter @app/aws dev`) talks to a Cognito emulator with the app's pool already in it: see
[infra/cognito-local/README.md](../infra/cognito-local/README.md). Integration tests use an
in-memory Cognito (`apps/api/test/fakeCognito.ts`); `apps/api/test/cognito.test.ts` checks the real
client's requests, SigV4, and ID-token verification with real keys; `apps/api/test/cognito.live.test.ts`
runs the real client against the emulator or a real pool (`COGNITO_LIVE=1`). The e2e suite starts its
own emulator and a stand-in for the user pool's managed login (`apps/web/e2e/fake-managed-login.mjs`),
so Continue with Google runs end to end in a browser.

## Troubleshooting

- **Every sign-in says "We can't reach the sign-in service"**: `COGNITO_USER_POOL_ID` /
  `COGNITO_CLIENT_ID` unset (the API logs it at startup), or Cognito unreachable. CloudWatch Logs
  `/aws/lambda/insights-production-api`.
- **"That email and password don't match" for a Firebase account**: `LEGACY_FIREBASE_API_KEY`
  unset or wrong, or a Cognito user already exists for that address (then Cognito's password is the
  one; "Forgot password?").
- **Google: `redirect_mismatch` / `invalid_request` at Cognito**: the app client's callback URL
  must be exactly `<APP_URL>/auth/callback`; Google's must be the stack's `ProviderRedirectUri`.
- **"This sign-in didn't start in this browser"**: the state cookie (`__oauth`, 10 minutes) is gone:
  third-party cookie blocking doesn't affect it (it's first-party), but a different browser or an
  expired attempt does. Start again.
- **Codes don't arrive**: Cognito's default sender allows 50 emails a day per account; check the spam
  folder, then set up SES (section 1).
