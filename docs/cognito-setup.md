# Sign-in: Amazon Cognito

bizinsights signs people in with an Amazon Cognito user pool: email and password (with emailed codes
for sign-up and password resets), Continue with Google, and optionally a passwordless emailed
code (Sign in with Apple was removed on 2026-10-16). It replaced Firebase Authentication; this page
covers how it works, how to set it up, and what is left of the move.

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
- **Audit**: `auth_events` records account-level changes (account created, identity linked, an
  account from before Cognito given its Cognito user, password reset/changed, email changed or
  verified, signed out everywhere, account deleted).

### Routes

| Route | What |
| --- | --- |
| `GET /api/auth/config` | which "Continue with ..." buttons work; whether emailed-code sign-in is on |
| `POST /api/auth/signup`, `/signup/confirm`, `/signup/resend` | create an account; confirm the emailed code |
| `POST /api/auth/login` | email + password |
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

Emails: left to itself Cognito sends codes from `no-reply@verificationemail.com`, limited to 50 a
day. Production doesn't: the Auth stack gives the pool a Custom Email Sender trigger (template
parameters `CustomEmailSenderState`, `CustomEmailSenderArn`, `CustomEmailKmsKeyArn`), a function
that sends every code through the app's mail provider (Resend) from `no-reply@bizinsights.io`
([aws-deployment.md](aws-deployment.md), "Sign-in emails"). For the passwordless code (`EMAIL_OTP`)
Cognito's documentation asks for SES: verify a domain in SES in the same region, get production access, and pass
`SesFromEmail` and `SesIdentityArn` to the template (`parameters` in `infra/cdk/lib/auth-stack.ts`).

## 2. Google

Continue with Google is off in production until this is done (`GET /api/auth/config` answers
`"google": false`). In Google Cloud, with a "Web application" OAuth client in a project the owner's
Google account controls:

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

## 4. Accounts from before Cognito

The move from Firebase is over, and the app no longer talks to Firebase at all:

- Until 2026-10-18 a password sign-in that Cognito refused was checked against Firebase once
  (`LEGACY_FIREBASE_API_KEY`), and the Cognito user was created with that password. That check, and
  the `ops:cognito-plan` / `ops:cognito-verify` tasks that planned the move, were removed
  (`git log --diff-filter=D -- apps/api/src/legacyFirebase.ts` finds the commit; its parent still
  has them). On that day production's database had no account left from
  Firebase: no `users.firebase_uid` set, no identity created by a move, and the API's logs since
  2026-10-15 show no Firebase sign-in at all.
- The old deployment's database (on the owner's PC; [aws-deployment.md](aws-deployment.md),
  "Cutover") still holds Firebase accounts. If any of them are merged in, they keep their
  `users.firebase_uid` and come back without Firebase: "Forgot password?" (or the emailed-code sign-in)
  creates their Cognito user (no email to them, random password) and Cognito emails a code; proving
  the inbox gets them into the same `users.id`, workspaces and stores. Continue with Google, or
  signing up again with the same address, links to it too, on the verified address. Their old
  password is not kept anywhere.
- `users.firebase_uid` stays: it is what "Forgot password?" recognises such an account by.
  `auth_identities.migrated_from_firebase_uid` is no longer written (no production row has it set);
  dropping it is a migration of its own.

Nothing is merged on an unverified address, and every step is recorded in `auth_events`. The old
deployment keeps signing its own users in with Firebase until it is retired
([aws-deployment.md](aws-deployment.md#retiring-the-old-cloudflare-deployment)).

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
- **"That email and password don't match" for an account from before Cognito**: its old Firebase
  password no longer works anywhere; "Forgot password?" gets them in (section 4).
- **Google: `redirect_mismatch` / `invalid_request` at Cognito**: the app client's callback URL
  must be exactly `<APP_URL>/auth/callback`; Google's must be the stack's `ProviderRedirectUri`.
- **"This sign-in didn't start in this browser"**: the state cookie (`__oauth`, 10 minutes) is gone:
  third-party cookie blocking doesn't affect it (it's first-party), but a different browser or an
  expired attempt does. Start again.
- **Codes don't arrive**: production sends them through Resend (the `cognito-email` function): check
  the spam folder, the alarm `insights-production-cognito-email-errors` and the function's log (its
  trigger and Resend's message id), then Resend's dashboard for that message and its daily quota.
  Without the trigger (`-c cognitoEmail=off`, staging) Cognito's own sender allows 50 emails a day.
