# Firebase setup

Firebase Auth handles identity for **our SaaS** (not for Shopify). The API never trusts the client: it verifies ID tokens itself (Identity Toolkit REST API and Google's public keys through `jose`, `apps/api/src/authProvider.ts`; no Admin SDK) and issues its own httpOnly session cookie (Firebase session cookies, 5-day expiry, revocation checked on every request).

## 1. Project

1. Create a Firebase project (it is also a Google Cloud project).
2. Authentication → Sign-in method, enable:
   - **Email/Password**, with **Email link (passwordless sign-in)** turned on too: sign-in codes are our own (OTP), but when the code email can't be sent, the app falls back to Firebase's email link ([deployment-cloudflare.md](deployment-cloudflare.md)).
   - **Google**.
   - **Apple**: needs an Apple Developer account. Create a Services ID, a Sign in with Apple key, and register the Firebase handler `https://<project>.firebaseapp.com/__/auth/handler` as the return URL (and `https://<your web domain>/__/auth/handler` too, see [section 5](#5-google--apple-sign-in-without-a-popup)). Paste Services ID, Team ID, Key ID and private key into Firebase.
3. Authentication → Settings → Authorized domains: add your web domain.
4. Authentication → Templates: customise the verification and password reset emails, and set the action URL to your domain if you host the action handler.

## 2. Credentials

| Where | Value |
| --- | --- |
| Web (`NEXT_PUBLIC_FIREBASE_API_KEY`, `..._AUTH_DOMAIN`, `..._PROJECT_ID`) | Project settings → Your apps → Web app config. These are public identifiers, not secrets. |
| API (`FIREBASE_SERVICE_ACCOUNT_B64`, a Worker secret) | Project settings → Service accounts → Generate key, then `base64 -w0 key.json`. Required on Workers (there is no workload identity): the Worker signs its own tokens with this key. |

Custom tokens (used by email OTP) are signed with that same service-account key.

## 3. Flows implemented

| Flow | Where |
| --- | --- |
| Email/password sign-up + verification email | `apps/web/src/app/signup`, `verify-email` |
| Password reset | `apps/web/src/app/reset` (same response whether or not the account exists) |
| Google / Apple | `apps/web/src/components/SocialButtons.tsx`: a redirect through our own `/__/auth/handler` when the build's auth domain is the web host ([section 5](#5-google--apple-sign-in-without-a-popup)), otherwise a popup |
| Session cookie | `POST /auth/session` — requires a sign-in within the last 5 minutes |
| Verification refresh | `POST /auth/sync-profile` — fresh ID token, same uid |
| **6-digit email OTP** | see below |

### Email OTP (custom; Firebase has no native 6-digit email code)

1. `POST /auth/otp/request {email}` — rate limited (3 per email / 15 min, 10 per IP / hour). Generates a CSPRNG code, stores only `HMAC-SHA256(pepper, email:code)` with a 10-minute expiry, invalidates earlier codes, emails it. Always returns `{ok:true}` (no account enumeration).
2. `POST /auth/otp/verify {email, code}` — 5 attempts per code (atomic counter), constant-time compare, single use (atomic consume). On success the API finds or creates the Firebase user for that email, marks the email verified (the code proved inbox control) and returns a **custom token**.
3. The browser calls `signInWithCustomToken`, then `POST /auth/session` like any other sign-in.

## 4. Local emulator

`docker compose up -d firebase-emulator` runs the Auth emulator on 9099. Set `FIREBASE_AUTH_EMULATOR_HOST=localhost:9099` (API) and `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR=http://localhost:9099` (web). Google/Apple popups show the emulator's fake account picker.

## 5. Google / Apple sign-in without a popup

With `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com`, "Continue with Google / Apple" opens a popup. It works, but Firebase checks `popup.closed` every 2 seconds while Google's sign-in page is open in it, and Google's Cross-Origin-Opener-Policy makes Chrome log `Cross-Origin-Opener-Policy policy would block the window.closed call` (and `window.close`) for every check. Those lines are harmless and only a popup causes them.

The Worker therefore serves Firebase's sign-in helper on our own origin: `/__/auth/*` is proxied to `<project>.firebaseapp.com` (`firebaseHelper` in `apps/cloudflare/src/index.ts`, Firebase's [option 3](https://firebase.google.com/docs/auth/web/redirect-best-practices)). When the web build's auth domain is the web host itself, the buttons redirect the whole page instead of opening a popup. To switch a deployment over, in this order:

1. Google Cloud console, the Firebase project → APIs & Services → Credentials → **Web client (auto created by Google Service)** → Authorized redirect URIs: add `https://<your web domain>/__/auth/handler` (production: `https://insights.imeseban.workers.dev/__/auth/handler`). Until it is there, Google answers `redirect_uri_mismatch`.
2. Apple, if enabled: add the same URL to the Services ID's return URLs.
3. Build the web UI with `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<your web domain>` (no `https://`) and deploy.

Switching back is step 3 with `<project>.firebaseapp.com` again. Local builds keep the popup: their auth domain is never the dev host.
