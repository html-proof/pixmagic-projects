# Sign-in: Amazon Cognito

bizinsights signs people in with an Amazon Cognito user pool: email and password (with emailed codes
for sign-up and password resets, a 6-digit code emailed after the password at every sign-in, and
opt-in two-step verification with an authenticator app), Continue with Google, and optionally a
passwordless emailed code (Sign in with Apple was removed on 2026-10-16). It replaced Firebase
Authentication; this page covers how it works, how to set it up, and what is left of the move.

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
  Cognito, so a user disabled or deleted there, or signed out everywhere, loses the session, and
  a session due for that check without its refresh-token cookie ends (the session cookie alone is
  never enough). Each request also checks the session's sign-in is still one of the account's
  (`auth_identities`), so removing a method, or a take-over, ends its sessions at once.
  `apps/api/src/session.ts`, `context.ts`. "Keep me signed in" unticked (on the sign-in page, also
  for Google) makes both cookies end with the browser.
- **Accounts**: `users.id` never changes. Each Cognito user (password, Google) is linked to
  it in `auth_identities` (provider, Cognito `sub`, user name, method). Several identities can point
  at one user (`apps/api/src/identity.ts`):
  - **Continue with Google is sign-up and sign-in in one** (the same button on `/login` and
    `/signup`): a Google account new to bizinsights, at an address no account has, becomes a new
    account on the spot, with the name, verified address and picture Google gives (`users.avatar_url`,
    the pool's `picture` mapping) and its Google identity (`auth_identities`: the Cognito user
    `google_<Google sub>`, method `google`); no form, no role anywhere until it makes or joins a
    workspace. Two first sign-ins at once make one account (the unique `(provider, subject)` and
    `users.email`). A returning Google account is found by its Cognito user.
  - A sign-in links to the existing account with the same address only when Cognito vouches for
    the address (a confirmed sign-up code; Google's `email_verified`). Never on an unverified one.
  - **A new Google account never joins an account that has its own ways in by its address alone**
    (Google's word for an address isn't proof the account is this person's, and it would skip the
    account's two-step verification). The callback answers `{ next: "link", email }` instead, with
    no session (the Google sign-in's refresh token is handed back) and nothing created: who the
    Google account is waits in the coordinator for 15 minutes under an id in an httpOnly cookie
    (`__link`, path `/api/auth`; `identity_link_pending`). The sign-in page says the address
    already has an account and asks the person to sign in to it the usual way (the password, its
    emailed code or the authenticator app's). That sign-in, in that browser, links the Google
    account (`identity_linked` with `via: "sign_in"`) and the account's address is emailed; a
    sign-in to another account links nothing and ends the hold; "Don't link Google" lets it go
    (`DELETE /api/auth/pending-link`). An account that already has a different Google account is
    refused (`google_other_linked`: one per account, as in Settings).
  - When that existing account's own address was never verified (an employee account made from a
    copied invitation link, whose password whoever opened the link chose), the verified sign-in
    takes it over: the account's other Cognito users are deleted, their identities removed, every
    session ended, and what that person set up undone: the API keys they made and the access and
    invitations they gave are revoked, and the account leaves the workspaces it made or claimed;
    memberships and employee records workspace owners gave the address stay
    (`unverified_identity_removed`, with counts). A Team & Access invitee's placeholder account
    has no sign-in yet and simply links. Only a sign-in or a code that verifies the account's own
    address counts: a Google account linked under another address (and that session's re-checks)
    never marks the account verified, nor does a verification code Cognito sent to another
    address (the API reads what Cognito vouches for after the code). Such an account can't link
    Google, can't change its address, and is never moved to another one by a sign-in.
  - The owner of such an address isn't locked out without Google: Cognito holds the address for
    that unverified password user (sign-up says "account exists") and sends it no reset code. So
    a sign-up or a password reset for it emails our own code (Cognito's wording, the app's
    mailer; an HMAC of it in the coordinator, 24 hours for a sign-up, 1 hour for a reset, five
    guesses an hour). Nothing changes until it is entered; then the unproven password user is
    deleted, the owner gets their own (address verified) and the account is taken over as above
    (`address_claim_started`, `address_claimed`). No Cognito permission beyond create and delete.
  - No account is created from a Google address Google hasn't verified: such an account could
    never verify it here (Google's tokens can't ask Cognito for a code).
  - Signing up again over a sign-up that was never confirmed: the same password sends a fresh
    code; another password replaces that sign-up (`unconfirmed_signup_replaced`). Whoever then
    enters the code proves the inbox, so the sign-up page sends its password with the code
    (`/signup/confirm` with `password`): if the confirmed sign-up has another password (someone
    signed up with the address after the owner), it is replaced with this one, its Cognito tokens
    end, and so does any session signed in with the old one (`signup_password_replaced`). A
    password Cognito wouldn't take (the sign-in page's code step sends what was typed there)
    leaves no password at all: "Forgot password?" sets one.
  - Settings → Security links a Google account whatever its address (started with
    `POST /api/auth/oauth/google/link` from our own pages, never a link another site could open;
    Google's account chooser every time; the person's own session at both ends of the trip, a
    sign-in in the last 15 minutes or the password just now, a verified address; refused when
    another account uses that Google account), adds a password to a Google-only account (a
    Cognito password user for the account's address, after a Google sign-in with that address in
    the last 15 minutes), and removes a method (never the last, nor the one signed in with; its
    Cognito user is deleted and its sessions end at once). Each addition and removal is emailed
    to the account's address. A Google session counts as the person again only when it proved the
    account's own address (the session's `own` claim, and that identity's address): one linked
    under another address needs the account's password to remove a method, and can't add a
    password (`GET /api/auth/account` says which: `confirmWith`). Deleting the account asks every
    session for a 6-digit code emailed to the account's own address instead (no password field in
    that dialog: beside one, browsers filled the address into the "Type DELETE" box). A removed Google
    account stays out even when its address is the account's: Cognito makes its federated user
    again on its next sign-in, but the removal (`identity_removed` with its Cognito user name, in
    `auth_events`) stops it linking back by address (`google_removed`) until it is linked again
    from Settings.
  - A password reset ends every session but not the other ways in: the reset's answer names them
    (`otherMethods`), and the sign-in page asks the person to check a linked Google account.
- **Two-step verification** (section 6): opt-in, for password accounts.
- **Tenancy is unchanged**: a sign-in says who someone is; workspaces, roles and permissions stay in
  our database (`requireWorkspace`, Postgres RLS).
- **The confidential app client's secret** signs every user-pool call (`SECRET_HASH`; a refresh's is
  keyed by the user's `sub`, as AWS says for a pool whose users sign in with their email, which a
  Google user's `google_<id>` name isn't). The API
  function's own role, which may make only five admin calls on this pool (create, get, set password,
  delete, sign out everywhere), signs the admin calls with SigV4. No access keys anywhere.
- **Audit**: `auth_events` records account-level changes (account created, identity linked or
  removed, an unverified account taken over, a claim of an address nobody proved started or
  completed, an unconfirmed sign-up replaced, a confirmed sign-up's password replaced by the code's
  owner, an account from before
  Cognito given its Cognito user, password reset/changed, email changed or verified, two-step
  verification on or off, signed out everywhere, account deleted).

### Routes

| Route | What |
| --- | --- |
| `GET /api/auth/config` | which "Continue with ..." buttons work; whether emailed-code sign-in is on |
| `POST /api/auth/signup`, `/signup/confirm`, `/signup/resend` | create an account (`challenge`: the code's countdowns, section 8); confirm the emailed code within its minute (with `password`: and sign in, that password becoming the account's); a new code once the minute is up |
| `POST /api/auth/login`, `/login/mfa` | email + password (`{ next: "mfa" }` when the account has two-step verification, `{ next: "code", email, challenge }` otherwise); then the authenticator app's code |
| `POST /api/auth/login/code`, `/login/code/resend`; `GET`, `DELETE /api/auth/login/code` | the emailed code after the password (section 8): enter it; another one after a minute; where this browser's sign-in stands after a reload; give it up |
| `POST /api/auth/password/forgot`, `/password/reset` | reset code by email; new password |
| `POST /api/auth/otp/start`, `/otp/verify` | passwordless code (only with `COGNITO_EMAIL_OTP=1`) |
| `GET /api/auth/oauth/google/start` | to Google to sign in, with state, PKCE and a nonce. `?keep=0`: "Keep me signed in" unticked. (`?link=1` no longer links: back to `returnTo` with `?link_error=start_again`) |
| `POST /api/auth/oauth/google/link` `{ returnTo }` | link Google to the signed-in account, from our own pages: `{ redirect }` to Google's account chooser (a sign-in in the last 15 minutes, or `POST /api/auth/account/methods/google/prepare` with the password first); back to `<returnTo>?linked=google` or `?link_error=<code>`; refusals are errors whose code the page puts there |
| `POST /api/auth/oauth/callback` | what the provider sent back (from the `/auth/callback` page): `{ user, redirect }`, `{ linked, redirect }` (Settings), or `{ next: "link", provider, email }` (the address is an existing account's: sign in to it to link) |
| `GET`, `DELETE /api/auth/pending-link` | the Google account held in this browser for an existing account (`{ pending, provider, email }`); let it go |
| `POST /api/auth/logout`, `/logout-all` | this browser; every device |
| `GET /api/auth/session`, `/api/auth/whoami`, `/api/me` | the session |
| `GET /api/auth/account` | Settings → Security: methods (with `id`), `hasPassword`, `canLinkGoogle`, `canAddPassword`, `confirmWith` (`password`, `recent_sign_in` or `own_address_sign_in`: what removing a method asks for), `mfaEnabled` (null: Cognito couldn't be asked) |
| `POST /api/auth/account/{password,password/add,email,email/confirm,verify-email/send,verify-email}` | change or add a password, change or verify the email |
| `POST /api/auth/account/delete/code`, `/delete` `{ confirm: "DELETE", code }` | delete the account: a code emailed to the account's address (`challenge`: its countdowns; 409 `sole_owner` before any email), then the code within its minute (section 8's rules: five guesses, one code a minute, the address's caps) |
| `DELETE /api/auth/account/methods/:id` | remove a sign-in method |
| `POST /api/auth/account/methods/google/prepare` | the password again, so this session may start one link to Google in the next 5 minutes |
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
that sends every code through the app's mail provider (Resend) from `support@bizinsights.io`
([aws-deployment.md](aws-deployment.md), "Sign-in emails" and "Who each email comes from"). For the passwordless code (`EMAIL_OTP`)
Cognito's documentation asks for SES: verify a domain in SES in the same region, get production access, and pass
`SesFromEmail` and `SesIdentityArn` to the template (`parameters` in `infra/cdk/lib/auth-stack.ts`).

## 2. Google

Done in production on 2026-10-19 (`GET /api/auth/config` answers `"google": true`); kept as the
recipe for another environment, or for redoing it. While it is not done, `/api/auth/config` answers
`"google": false` and the sign-in pages show no Google button. The owner's steps, in this order.
Nothing is clicked in the Cognito console, and nobody runs `cdk deploy` by hand. Two things found
on 2026-10-20 that the steps below now include: the consent screen's publishing status must be
**In production** (in "Testing" only listed test users can sign in, and the project owner's own
account passing hides that), and a logo plus brand verification are what make Google's screen say
"bizinsights" instead of the redirect domain (docs/integrations-readiness.md).

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
5. **The client id** (`….apps.googleusercontent.com`; not a secret, every Google sign-in page's
   address carries it): the environment's `googleClientId` in `infra/cdk/lib/config.ts`, merged to
   `main` (production's is there). The GitHub variable `GOOGLE_SIGNIN_CLIENT_ID` (Settings →
   Environments → `production` → Environment variables), when set, overrides it in every Deploy run;
   it holds the same id.
6. **Deploy**: the merge's own Deploy to AWS run, or Actions → Deploy to AWS → Run workflow, on
   `main` (a merge of only docs starts no deploy). The workflow passes `-c googleClientId=…`, empty
   without the GitHub variable, which keeps config.ts's; the Auth stack creates the Google identity
   provider, adds it to the app client and sets `COGNITO_IDENTITY_PROVIDERS` to `Google` in the
   runtime parameter. Its step "Restart the functions on changed runtime settings" then publishes the
   functions again (each restart writes the run's id into their description, so every change
   publishes a new version, even a second one on the same commit), so no instance that started
   during the deploy keeps the old setting. The deploy role may read
   `/insights/production/runtime` and update and publish the three functions (ci-stack.ts). The
   one run that first grants it read the settings before it had it, so it only warns that it
   couldn't read them: if Google was switched on in that same run, restart them by hand once
   ([aws-deployment.md](aws-deployment.md), "Restarting the functions").
7. **Check**: `curl https://bizinsights.io/api/auth/config` answers `"google":true`;
   `curl -sI https://bizinsights.io/api/auth/oauth/google/start` answers 302 to
   `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/authorize?…identity_provider=Google…`;
   then Continue with Google on `/login` in a private window ends on the dashboard (or onboarding,
   for a new account).

The identity provider (`GoogleProvider` in `infra/aws/cognito.yaml`) asks Google for `openid email
profile` and maps `email`, `email_verified` (without it no Google address counts as verified, and
nothing links), `name`, `given_name`, `family_name` and `picture` (the account's profile picture)
to the pool's attributes. Changing the mapping is an in-place update of the provider, made by the
Deploy run like any other change; a user's attributes follow at their next Google sign-in.

To switch it off again, empty the environment's `googleClientId` in config.ts, delete the GitHub
variable (it would put the id back) and ship the change through `main`.

## 3. The app

Nothing to set by hand: the runtime parameter carries the pool's ids and domain, the API function
reads `COGNITO_CLIENT_SECRET` from the stack's Secrets Manager secret at cold start, and its role
signs the admin calls (`apps/aws/src/secrets.ts`, `apps/aws/src/index.ts`). `COGNITO_EMAIL_OTP=1`
goes in `APP_SETTINGS` (`apps/aws/src/settings.ts`) only once SES is set up. The web build needs
nothing: every environment uses the same UI build.

## 4. Accounts from before Cognito

Sign-in before Cognito was Firebase Authentication. Nothing of it is left in the app: the API never
calls Firebase, and there is no Firebase setting, key or library. The two columns that marked an
account from that time, `users.firebase_uid` and `auth_identities.migrated_from_firebase_uid`, were
dropped by the migration `20261020120000_drop_firebase_columns`, in a release of its own: the
release before it (PR #163) had already stopped reading them (`@ignore` in `schema.prisma`) and was
live, so the release a failed deploy rolls back to can't miss them (a release that still selected
them must never meet a database without them). The password check against Firebase at a first
Cognito sign-in ended on 2026-10-18
(`git log --diff-filter=D -- apps/api/src/legacyFirebase.ts` finds the commit that removed it);
production had no account from Firebase by then: no `users.firebase_uid` set, no identity created
by a move, and no Firebase sign-in in the API's logs since 2026-10-15.

The old deployment's database (on the owner's PC; [aws-deployment.md](aws-deployment.md),
"Cutover") still holds accounts that signed in with Firebase. If any are merged in, they come back
without Firebase, on their verified address: signing up again with the same email (or Continue with
Google) links the new Cognito user to the same `users.id`, workspaces and stores (`resolveUser` in
`apps/api/src/identity.ts`). "Forgot password?" alone can't get them in: it asks Cognito for a code,
and Cognito has no user for them yet. Their old password is kept nowhere, nothing is merged on an
unverified address, and every link is recorded in `auth_events`. The old deployment keeps signing
its own users in with Firebase until it is retired
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
  `/api/auth/login/mfa`, which answers it (`RespondToAuthChallenge` as the user the challenge
  names, `USER_ID_FOR_SRP`, never the email: the pool's users are named by a UUID, and a challenge's
  `USERNAME` can't be an alias; `SECRET_HASH` from that name) and sets
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
which the owner can't verify with Google: Google's screen shows an app's name and logo only once
the project's branding is verified, and until then the domain of the redirect URI, so Continue
with Google says "to continue to insights-605411278365.auth.ap-southeast-2.amazoncognito.com".
`cognitoCustomDomain` (`infra/cdk/lib/config.ts`; production has `auth.bizinsights.io` in use since
release 81, 2026-10-20, done in the order below) gives the pool its own domain beside the prefix one (a resource of its own,
`CustomUserPoolDomain`: the prefix domain is never replaced and keeps working). Its `inUse` flag
moves sign-in over in a second step, so Continue with Google keeps working throughout: with
`inUse: false` the domain exists (its CloudFront target, for the DNS record) while the app
(`COGNITO_DOMAIN`) and Google's redirect URI stay on the prefix domain; with `inUse: true` the app
uses it and Google's redirect URI becomes `https://auth.bizinsights.io/oauth2/idpresponse`. The
ID tokens are unaffected (their issuer and keys are the pool's, not the domain's). In this order:

1. **Certificate**: ACM in **us-east-1** (N. Virginia; Cognito serves the domain through CloudFront)
   → Request a public certificate for `auth.bizinsights.io`, DNS validation. Add the CNAME ACM shows
   at Cloudflare (DNS only) and wait for "Issued". The app's own certificate
   (`bizinsights.io` + `www.bizinsights.io`, aws-deployment.md "Domain: bizinsights.io") doesn't
   cover it: no wildcard.
2. **Config, first step**: in `infra/cdk/lib/config.ts`, production gets
   `cognitoCustomDomain: { name: "auth.bizinsights.io", certificateArn: "arn:aws:acm:us-east-1:605411278365:certificate/…", inUse: false }`;
   pull request, merge, and the Deploy to AWS run creates the domain and prints the Auth stack's
   outputs `CustomDomainTarget` and `CustomDomainRedirectUri`. Cognito wants `bizinsights.io` itself
   to resolve (it does, through Cloudflare). Sign-in is untouched.
3. **DNS**: `CustomDomainTarget` (`….cloudfront.net`) → Cloudflare → DNS → CNAME `auth` → that
   target, **DNS only (grey cloud)**: Cognito's CloudFront serves the certificate itself, and
   Cloudflare's proxy in front would break it. It can take up to an hour;
   `curl -sI https://auth.bizinsights.io/oauth2/authorize` answering `302` to
   `https://auth.bizinsights.io/error?error=Required+parameters+missing` (Cognito's own answer,
   not a connection or certificate error) shows it serves. Hosted-UI domains publish no
   `/.well-known/openid-configuration` (404 on the prefix domain too; checked 2026-10-20): the
   pool's OpenID configuration lives at
   `https://cognito-idp.ap-southeast-2.amazonaws.com/<pool id>/.well-known/openid-configuration`.
4. **Google**: on the sign-in OAuth client add the redirect URI `https://auth.bizinsights.io/oauth2/idpresponse`
   (`CustomDomainRedirectUri`) and the JavaScript origin `https://auth.bizinsights.io`, keeping the
   `amazoncognito.com` ones for now.
5. **Config, second step**: `inUse: true`; pull request, merge. The deploy moves the app to the
   domain, and its step "Restart the functions on changed runtime settings" restarts the functions.
6. **Check**: `curl https://bizinsights.io/api/auth/oauth/google/start -sI` sends to
   `https://auth.bizinsights.io/oauth2/authorize?…`, and Continue with Google signs in; Google's
   screen now says "to continue to bizinsights.io".
7. **Afterwards**: remove the `amazoncognito.com` redirect URI and JavaScript origin from the
   client, and `amazoncognito.com` from the consent screen's Authorized domains. Then verify the
   sign-in project's branding (Google Auth Platform → Branding: name bizinsights, the logo,
   homepage, privacy and terms on bizinsights.io → Verification Center), so Google's screen shows
   the name and logo instead of the domain (docs/integrations-readiness.md).

## 8. Emailed codes: a minute, five guesses, one a minute

Every 6-digit code the sign-in pages ask for (the sign-up code that confirms the address, and the
code emailed after the password) follows the same rules, enforced by the API on its own clock
(`apps/api/src/emailCode.ts`); the pages' countdowns only show them:

- **A code lives 60 seconds** from the moment it is issued. The page counts down from the server's
  `challenge` (`issuedAt`, `expiresAt`, `resendAt`, and the server's `now`, so a device whose clock
  is off still counts the right minute); a code offered later is refused (`expired_code`, "This
  code has expired. Request a new code.") before anything looks at it. A reload doesn't reset it:
  the sign-in page asks `GET /api/auth/login/code` where its pending sign-in stands, and a sign-up
  form sent again within the minute gets the code already sent, with the time it has left.
- **Five wrong guesses** end the code (`too_many_attempts`, 429): a new one has to be asked for. The
  guesses are counted in the coordinator (DynamoDB), so they add up across function instances; the
  per-IP limit `codeVerifyIp` sits on top.
- **Another code after a minute**: a resend before that is refused (`resend_cooldown`, 429 with
  `Retry-After` and the standing code's `challenge` in `detail`), so at most one code stands at a
  time and a new one always replaces an expired one. One address gets at most
  `AUTH_CODE_LIMIT_HOURLY` codes an hour and `AUTH_CODE_LIMIT_DAILY` a day (sign-up and sign-in
  together; 6 and 20 in `apps/aws/src/settings.ts`), one IP at most `codeIp` (60 an hour).
- **The sign-up code is Cognito's** (`SignUp` sends it through the custom email sender,
  `ConfirmSignUp` checks it and marks the address verified), and Cognito itself would keep it for
  24 hours: that lifetime can't be changed. The code never reaches Cognito except through the API
  (the app client is confidential, its secret signs every call), and the API refuses it after the
  minute and discards it once it has worked, so the minute is the only lifetime that counts.
- **The sign-in code is the app's own.** Cognito's email one-time codes (passwordless `EMAIL_OTP`,
  and email as a second factor) need an Amazon SES email configuration in the pool, and this
  account's SES is still in the sandbox (production access denied, [aws-deployment.md](aws-deployment.md)),
  so they can't be used; Cognito's challenge sessions also last at least 3 minutes
  (`AuthSessionValidity`), never one. So after a right password (`InitiateAuth`), the API keeps
  Cognito's tokens in the coordinator, AES-GCM under `TOKEN_ENCRYPTION_KEYS` and bound to an id
  that only this browser's httpOnly cookie `__login` (path `/api/auth/login`, 10 minutes) names,
  emails a code of its own through the app's mail provider (Resend, `CustomEmailSender_Authentication`
  wording), and stores only the code's HMAC (`OTP_PEPPER`). `POST /api/auth/login/code` checks the
  minute and the guesses, compares in constant time, spends the record with one atomic delete (two
  right answers racing: one signs in), and only then sets the session (`finishSignIn`, "Keep me
  signed in" as ticked with the password). A pending sign-in given up (`DELETE`), ended by wrong
  guesses or refused (the email couldn't be sent, the caps) hands its refresh token back to Cognito.
  Nothing of the sign-in reaches the browser before the code: no session, no token.
- **Accounts with an authenticator app keep that step** (section 6): Cognito's `SOFTWARE_TOKEN_MFA`
  challenge comes first and the emailed code isn't asked for as well, so nothing is downgraded.
  Google sign-ins have Google's own verification and get neither.
- **Off switch**: `AUTH_LOGIN_EMAIL_CODE` empty (`apps/aws/src/settings.ts`, then a deploy) and the
  password alone signs in, as before; `GET /api/auth/config` says `loginCode`.
- **Exempt addresses**: `AUTH_LOGIN_CODE_EXEMPT` (same file, comma-separated) lists accounts whose
  password alone signs in while everyone else gets the code: the account given to Meta's App Review
  reviewers, who can't read its inbox ([ads-review-packs.md](ads-review-packs.md)). An authenticator
  app still applies to them. Each such sign-in logs `login_code_exempt`; the config report counts
  the addresses (`auth.loginCodeExempt`). Empty it once the review is over.
- The pages: six boxes (`OtpInput` in `apps/web/src/components/auth/CodeStep.tsx`: typing moves on,
  Backspace back, a pasted or autofilled code fills them all and the sixth digit sends), "Code
  expires in 00:59", "Resend code in 00:59" then "Resend verification code", "Use a different email
  address", and the messages "The verification code is incorrect. Please try again.", "This code
  has expired. Request a new code.", "A new verification code has been sent.", "Too many attempts.
  Please try again later." and "Email verified successfully."

## Troubleshooting

- **Every sign-in says "We can't reach the sign-in service"**: `COGNITO_USER_POOL_ID` /
  `COGNITO_CLIENT_ID` unset (the API logs it at startup), or Cognito unreachable. CloudWatch Logs
  `/aws/lambda/insights-production-api`.
- **"That email and password don't match" for an account from before Cognito**: its old password
  works nowhere any more; signing up again with the same address links to its account (section 4).
- **Google: `redirect_mismatch` / `invalid_request` at Cognito**: the app client's callback URL
  must be exactly `<APP_URL>/auth/callback`; Google's must be the stack's `ProviderRedirectUri`.
- **`/api/auth/config` still says `"google": false` after section 2**: the client id is in
  config.ts on `main` (or the GitHub variable is on the `production` environment, not the
  repository), its Deploy run succeeded, and the run's step "Restart the functions on changed
  runtime settings" ran; otherwise restart them by hand
  ([aws-deployment.md](aws-deployment.md), "Restarting the functions").
- **Google: `redirect_uri_mismatch`**: the OAuth client's Authorized redirect URI must be exactly
  the stack's `ProviderRedirectUri` (section 2, step 3).
- **Google lets only some people in (`access_denied` for the rest)**: the consent screen's
  publishing status is still "Testing", which admits its listed test users only (section 2, step 2).
- **"This sign-in didn't start in this browser"**: the state cookie (`__oauth`, 10 minutes) is gone:
  third-party cookie blocking doesn't affect it (it's first-party), but a different browser or an
  expired attempt does. Start again.
- **Codes don't arrive**: production sends them through Resend. Sign-up codes go through the
  `cognito-email` function: check the spam folder, the alarm `insights-production-cognito-email-errors`
  and the function's log (its trigger and Resend's message id), then Resend's dashboard for that
  message and its daily quota. Without the trigger (`-c cognitoEmail=off`, staging) Cognito's own
  sender allows 50 emails a day. The code after the password is sent by the API function itself
  (`could not email a sign-in code` in `/aws/lambda/insights-production-api`; the person then sees
  "We couldn't send you an email right now", 503, and nothing is signed in).
- **"This code has expired" straight away, or every code**: the API's clock and the coordinator
  (DynamoDB) decide, not the device's; a function instance whose clock was off would show in the
  `challenge.now` the pages receive. Codes live 60 seconds from the API's `issuedAt` (section 8).
