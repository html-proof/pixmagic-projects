# Local Cognito (emulator)

Sign-in runs on Amazon Cognito (`docs/cognito-setup.md`). For local development and the e2e suite the
local server talks to [cognito-local](https://github.com/jagregory/cognito-local) instead, with the app's
pool and client already in it:

```
node infra/cognito-local/start.mjs          # or: docker compose up -d cognito
```

`apps/aws/.env` (from `apps/aws/.env.example`, which already has these) then needs:

```
COGNITO_ENDPOINT=http://127.0.0.1:9229
COGNITO_USER_POOL_ID=local_insights
COGNITO_CLIENT_ID=insightslocalwebclient00
COGNITO_CLIENT_SECRET=insights-local-client-secret
COGNITO_ADMIN_ACCESS_KEY_ID=local
COGNITO_ADMIN_SECRET_ACCESS_KEY=local
```

The client secret is a published test value: production refuses to start with it, and with any
`COGNITO_ENDPOINT` (`developmentSettings()` in `packages/core/src/env.ts`).

Codes Cognito would email (sign-up, password reset, email verification) appear in the emulator's
output and in `data/.cognito/db/local_insights.json` (`ConfirmationCode`, `AttributeVerificationCode`).

Where the emulator differs from Cognito (none of it changes how the app behaves against AWS):

- Confirming a sign-up doesn't mark the email verified, so a new local account is also asked to
  verify its address once signed in (`/verify-email`). Cognito marks it verified on confirmation.
- A wrong password is `InvalidPasswordException` there (the client maps it to Cognito's
  `NotAuthorizedException`).
- No managed login: "Continue with Google" can't be tried locally. Its server side is
  covered by `apps/api/test/auth.test.ts`; against Google it needs the real pool.
- No `GlobalSignOut` / `AdminUserGlobalSignOut` / refresh-token rotation: "Sign out everywhere"
  still ends every session (our own record), and logs that Cognito's part failed.
