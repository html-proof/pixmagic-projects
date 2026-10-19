# Sign-in: Amazon Cognito

bizinsights signs people in with an Amazon Cognito user pool: email and password (with emailed codes
for sign-up and password resets, and opt-in two-step verification with an authenticator app),
Continue with Google, and optionally a passwordless emailed code (Sign in with Apple was removed on
2026-10-16). It replaced Firebase Authentication; this page covers how it works, how to set it up,
and what is left of the move.

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
  to `/api` only). Each request costs one HMAC; every minute the refresh token is spent with
  Cognito, so a user disabled or deleted there, or signed out everywhere, loses the session.
  `apps/api/src/session.ts`. "Keep me signed in" unticked (on the sign-in page, also for Google)
  makes both cookies end with the browser.
- **Accounts**: `users.id` never changes. Each Cognito user (password, Google) is linked to
  it in `auth_identities` (provider, Cognito `sub`, user name, method). Several identities can point
  at one user (`apps/api/src/identity.ts`):
  - A sign-in links to the existing account with the same address only when Cognito vouches for
    the address (a confirmed sign-up code; Google's `email_verified`). Never on an unverified one.
  - When that existing account's own address was never verified (an employee account made from a
    copied invitation link, whose password whoever opened the link chose), the verified sign-in
    takes it over: the account's other Cognito users are deleted, their identities removed, every
    session ended (`unverified_identity_removed`). A Team & Access invitee's placeholder account
    has no sign-in yet and simply links.
  - No account is created from a Google address Google hasn't verified: such an account could
    never verify it here (Google's tokens can't ask Cognito for a code).
  - Signing up again over a sign-up that was never confirmed: the same password sends a fresh
    code; another password replaces that sign-up (`unconfirmed_signup_replaced`), so the password
    that works after the code is the one typed last, never a stranger's.
  - Settings → Security links a Google account whatever its address (the person's own session at
    both ends of the trip, refused when another account uses that Google account), adds a password
    to a Google-only account (a Cognito password user for the account's address, after a Google
    sign-in in the last 15 minutes), and removes a method (never the last, nor the one signed in
    with; its Cognito user is deleted).
- **Two-step verification** (section 6): opt-in, for password accounts.
- **Tenancy is unchanged**: a sign-in says who someone is; workspaces, roles and permissions stay in
  our database (`requireWorkspace`, Postgres RLS).
- **The confidential app client's secret** signs every user-pool call (`SECRET_HASH`). The API
  function's own role, which may make only five admin calls on this pool (create, get, set password,
  delete, sign out everywhere), signs the admin calls with SigV4. No access keys anywhere.
- **Audit**: `auth_events` records account-level changes (account created, identity linked or
  removed, an unverified account taken over, an unconfirmed sign-up replaced, an account from before
  Cognito given its Cognito user, password reset/changed, email changed or verified, two-step
  verification on or off, signed out everywhere, account deleted).

### Routes

| Route | What |
| --- | --- |
| `GET /api/auth/config` | which "Continue with ..." buttons work; whether emailed-code sign-in is on |
| `POST /api/auth/signup`, `/signup/confirm`, `/signup/resend` | create an account; confirm the emailed code |
| `POST /api/auth/login`, `/login/mfa` | email + password (`{ next: "mfa" }` when the account has two-step verification); then the app's code |
| `POST /api/auth/password/forgot`, `/password/reset` | reset code by email; new password |
| `POST /api/auth/otp/start`, `/otp/verify` | passwordless code (only with `COGNITO_EMAIL_OTP=1`) |
| `GET /api/auth/oauth/google/start` | to Google, with state, PKCE and a nonce. `?keep=0`: "Keep me signed in" unticked. `?link=1&returnTo=<path>`: link Google to the signed-in account; back to `<path>?linked=google` or `?link_error=<code>` |
| `POST /api/auth/oauth/callback` | what the provider sent back (from the `/auth/callback` page) |
| `POST /api/auth/logout`, `/logout-all` | this browser; every device |
| `GET /api/auth/session`, `/api/auth/whoami`, `/api/me` | the session |
| `GET /api/auth/account` | Settings → Security: methods (with `id`), `hasPassword`, `canLinkGoogle`, `mfaEnabled` (null: Cognito couldn't be asked) |
| `POST /api/auth/account/{password,password/add,email,email/confirm,verify-email/send,verify-email,delete}` | change or add a password, change or verify the email, delete the account |
| `DELETE /api/auth/account/methods/:id` | remove a sign-in method |
| `POST /api/auth/account/mfa/{setup,verify,disable}` | two-step verification (section 6) |

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
(CloudFront's) and the domain prefix (`cognitoDomainPrefix` in `infra/cdk/lib/config.ts`; an own
domain beside it is optional, section 7). The same
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
`"google": false`, and the sign-in pages show no Google button). The owner's steps, in this order.
Nothing is clicked in the Cognito console, and nobody runs `cdk deploy` by hand.

1. **A Google Cloud project for sign-in only.** Create a new project (for example "bizinsights
   sign-in"); don't use `insights-511119`, the Google Ads and AdSense project. Its consent screen
   has to pass Google's verification for the Ads scope, and a verified consent screen may list only
   domains the owner has verified in Search Console, which `amazoncognito.com` can't be. A project
   that asks for nothing but `openid`, `email` and `profile` needs no verification at all.
2. **Its OAuth consent screen** (Google Auth Platform): audience **External**, app name
   "bizinsights", the support email; **Authorized domains** `bizinsights.io` and
   `amazoncognito.com` (just `bizinsights.io` with the own sign-in domain, section 7); **Data
   access**: only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`; publishing
   status **In production** (while it is "Testing", only its listed test users can sign in).
3. **Clients → Create client → Web application** ("bizinsights sign-in"):
   - **Authorized JavaScript origins**: `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com`
   - **Authorized redirect URIs**: exactly
     `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse`
     (the Auth stack's output `ProviderRedirectUri`; section 1 shows how to list them).
4. **The client secret**, before the deploy: copy it with Google's copy button, then on the PC run
   `node infra/cdk/scripts/put-secrets.mjs --env production --set GOOGLE_SIGNIN_CLIENT_SECRET`. It
   reads the clipboard, refuses anything that doesn't start with `GOCSPX-` and prints names only.
   CloudFormation reads it from `insights/production/app` at deploy time (it is never in the
   template); without it the Auth stack's update fails and the deploy rolls back.
5. **The client id**: GitHub → the repository → Settings → Environments → `production` →
   Environment variables → `GOOGLE_SIGNIN_CLIENT_ID` = the client id (`….apps.googleusercontent.com`).
6. **Deploy**: Actions → Deploy to AWS → Run workflow, on `main` (a merge of only docs starts no
   deploy). The workflow passes `-c googleClientId=…`; the Auth stack creates the Google identity
   provider, adds it to the app client and sets `COGNITO_IDENTITY_PROVIDERS` to `Google` in the
   runtime parameter. Its step "Restart the functions on changed runtime settings" then publishes the
   functions again, so no instance that started during the deploy keeps the old setting. If that
   step only warns that it couldn't read the runtime settings, restart them by hand
   ([aws-deployment.md](aws-deployment.md), "Restarting the functions").
7. **Check**: `curl https://bizinsights.io/api/auth/config` answers `"google":true`;
   `curl -sI https://bizinsights.io/api/auth/oauth/google/start` answers 302 to
   `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/authorize?…identity_provider=Google…`;
   then Continue with Google on `/login` in a private window ends on the dashboard (or onboarding,
   for a new account).

To switch it off again, delete the GitHub variable and run Deploy to AWS.

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
so Continue with Google runs end to end in a browser. The in-memory Cognito also models two-step
verification with real TOTP codes (`totpCode()`), so `apps/api/test/mfa.test.ts` signs in with them.

## 6. Two-step verification (an authenticator app)

Opt-in, for accounts that sign in with a password: Cognito's own TOTP (`MfaConfiguration: OPTIONAL`,
`EnabledMfas: [SOFTWARE_TOKEN_MFA]` in `cognito.yaml`; no text messages, so nothing to pay for).
Cognito asks for a code only from users who set one up and turned it on, so everyone else signs in
exactly as before. Google sign-ins don't get it here: Google has its own 2-Step Verification, and
Google's tokens can't change the Cognito user anyway.

- **Turning it on** (Settings → Security → Two-step verification): the current password (or a
  sign-in in the last 15 minutes) → `AssociateSoftwareToken` gives the secret, shown once as text
  and as an `otpauth://` link for a phone → a code from the app → `VerifySoftwareToken` and
  `SetUserMFAPreference` (on, preferred). `mfa_enabled` in `auth_events`.
- **Signing in**: the password is right and Cognito answers the challenge `SOFTWARE_TOKEN_MFA`. The
  API keeps Cognito's challenge session in the coordinator (`mfa:signin:<random id>`, 3 minutes:
  the app client's `AuthSessionValidity`), sets the httpOnly cookie `__mfa` (path `/api/auth/login`)
  naming it, and answers `{ next: "mfa" }`; the page asks for the code and posts it to
  `/api/auth/login/mfa`, which answers it (`RespondToAuthChallenge`, with `SECRET_HASH`) and sets
  the session as usual, "Keep me signed in" as ticked with the password. Codes are limited per IP
  and per account (`mfaVerifyIp`, `mfaVerifyAccount`) on top of Cognito's own limit; when Cognito
  ends the challenge (too slow, too many wrong codes) the page goes back to the password.
- **Turning it off**: the password and a current code, checked the way a sign-in checks them
  (Cognito has no other way to check the code of an app already set up), then
  `SetUserMFAPreference` (off). `mfa_disabled`.
- A password change with it on signs this browser out too: the new password needs a code.
  "Forgot password?" resets the password only; the code is still asked for.
- **Lost phone** (the owner's step, after making sure it is the account's owner asking): find the
  person's password identity (`SELECT username FROM auth_identities WHERE method = 'password' AND user_id = …`)
  and run `aws cognito-idp admin-set-user-mfa-preference --region ap-southeast-2 --user-pool-id <pool id>
  --username <that username> --software-token-mfa-settings Enabled=false,PreferredMfa=false`. They
  sign in with the password and can set up a new app. The API's role can't do this, on purpose.

Not checked against a real pool (only Cognito's documentation and the in-memory one): whether a
challenge session survives a wrong code (the API copes either way: a refused session sends the person
back to the password), and the exact exception for a wrong code at `VerifySoftwareToken` (both
`CodeMismatchException` and `EnableSoftwareTokenMFAException` are taken as "that code isn't right").

## 7. Own sign-in domain (optional)

Google's sign-in pages name the pool's OAuth domain, `insights-605411278365.auth.ap-southeast-2.amazoncognito.com`,
which the owner can't verify with Google. `cognitoCustomDomain` (`infra/cdk/lib/config.ts`, unset
in production: nothing changes until it is set) gives the pool its own domain beside the prefix
one (a resource of its own, `CustomUserPoolDomain`: the prefix domain is never replaced and keeps
working). Once it exists the app uses it (`COGNITO_DOMAIN`) and Google's redirect URI becomes
`https://auth.bizinsights.io/oauth2/idpresponse`. While Google sign-in is off, do this first and use
the new addresses in section 2; with Google on, Continue with Google fails from the deploy until
the DNS record and the redirect URI are in place.

1. **Certificate**: ACM in **us-east-1** (N. Virginia; Cognito serves the domain through CloudFront)
   → Request a public certificate for `auth.bizinsights.io`, DNS validation. Add the CNAME ACM shows
   at Cloudflare (DNS only) and wait for "Issued".
2. **Config**: in `infra/cdk/lib/config.ts`, production gets
   `cognitoCustomDomain: { name: "auth.bizinsights.io", certificateArn: "arn:aws:acm:us-east-1:605411278365:certificate/…" }`;
   pull request, merge, and the Deploy to AWS run adds the domain. Cognito wants `bizinsights.io`
   itself to resolve (it does, through Cloudflare).
3. **DNS**: the Auth stack's output `CustomDomainTarget` (`….cloudfront.net`) → Cloudflare → DNS →
   CNAME `auth` → that target, **DNS only (grey cloud)**: Cognito's CloudFront serves the
   certificate itself, and Cloudflare's proxy in front would break it. It can take up to an hour.
4. **Google**: on the sign-in OAuth client add the redirect URI `https://auth.bizinsights.io/oauth2/idpresponse`
   and the JavaScript origin `https://auth.bizinsights.io`; once Continue with Google works, remove
   the `amazoncognito.com` ones, and `amazoncognito.com` from the consent screen's Authorized domains.
5. **Check**: `curl https://bizinsights.io/api/auth/oauth/google/start -sI` sends to
   `https://auth.bizinsights.io/oauth2/authorize?…`, and Continue with Google signs in.

## Troubleshooting

- **Every sign-in says "We can't reach the sign-in service"**: `COGNITO_USER_POOL_ID` /
  `COGNITO_CLIENT_ID` unset (the API logs it at startup), or Cognito unreachable. CloudWatch Logs
  `/aws/lambda/insights-production-api`.
- **"That email and password don't match" for an account from before Cognito**: its old Firebase
  password no longer works anywhere; "Forgot password?" gets them in (section 4).
- **Google: `redirect_mismatch` / `invalid_request` at Cognito**: the app client's callback URL
  must be exactly `<APP_URL>/auth/callback`; Google's must be the stack's `ProviderRedirectUri`.
- **`/api/auth/config` still says `"google": false` after section 2**: the GitHub variable is on
  the `production` environment (not the repository), and the Deploy run's step "Restart the
  functions on changed runtime settings" ran; otherwise restart them by hand
  ([aws-deployment.md](aws-deployment.md), "Restarting the functions").
- **Google: `redirect_uri_mismatch`**: the OAuth client's Authorized redirect URI must be exactly
  the stack's `ProviderRedirectUri` (section 2, step 3).
- **Google lets only some people in (`access_denied` for the rest)**: the consent screen's
  publishing status is still "Testing", which admits its listed test users only (section 2, step 2).
- **"This sign-in didn't start in this browser"**: the state cookie (`__oauth`, 10 minutes) is gone:
  third-party cookie blocking doesn't affect it (it's first-party), but a different browser or an
  expired attempt does. Start again.
- **Codes don't arrive**: production sends them through Resend (the `cognito-email` function): check
  the spam folder, the alarm `insights-production-cognito-email-errors` and the function's log (its
  trigger and Resend's message id), then Resend's dashboard for that message and its daily quota.
  Without the trigger (`-c cognitoEmail=off`, staging) Cognito's own sender allows 50 emails a day.
