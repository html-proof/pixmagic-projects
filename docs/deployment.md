# Deployment (Google Cloud via Terraform)

Topology: three Cloud Run services (`insights-web`, `insights-api`, `insights-worker`), Cloud SQL Postgres 17 (private IP, PITR backups, regional HA), Memorystore Redis (HA), Secret Manager, a Serverless VPC connector. Firebase Auth lives in the same project.

| Domain | Points to | Serves |
| --- | --- | --- |
| `app.example.com` | insights-web | UI, plus `/api/*` proxied to the API (OAuth callback, session cookies) |
| `api.example.com` | insights-api | Shopify webhooks, web pixel ingest, API-key clients |

## First deploy

1. **State bucket:** `gsutil mb gs://<project>-tfstate`.
2. **Infra:**

```bash
terraform -chdir=infra/terraform init -backend-config="bucket=<project>-tfstate"
```

```bash
terraform -chdir=infra/terraform apply -var project_id=<project> -var app_domain=app.example.com -var api_domain=api.example.com -var shopify_api_key=<client id> -var image_tag=<git sha>
```

3. **Database users:** in Cloud SQL create user `app` (owner, used for migrations, API system paths and worker) and `app_rls` (strong password). Run `infra/postgres/init.sql` as `app` once (it creates grants for `app_rls`). Change the `app_rls` password from the dev default.
4. **Secrets:** add a version to each Secret Manager secret:
   - `DATABASE_URL` = `postgresql://app:<pw>@<private-ip>:5432/app?sslmode=require`
   - `APP_DATABASE_URL` = same with `app_rls`
   - `TOKEN_ENCRYPTION_KEYS` = `1:<openssl rand -base64 32>`
   - `SESSION_SECRET`, `OTP_PEPPER` = `openssl rand -base64 48`
   - `SHOPIFY_API_SECRET`, `SMTP_URL` (e.g. `smtps://user:pass@smtp.provider:465`), optional `ALERT_SLACK_WEBHOOK_URL`
5. **Images:** build and push the three targets (`api`, `worker`, `web`) from the root `Dockerfile` to `REGION-docker.pkg.dev/<project>/insights/<target>:<sha>`. `NEXT_PUBLIC_FIREBASE_*` are build args for `web`, and `API_INTERNAL_URL` must be set at **build** time because Next.js bakes rewrites into the build.
6. **Migrations:** run the `migrate` target as a Cloud Run job before rolling out services.
7. **Domains:** map the domains to the Cloud Run services (or a load balancer), then update `shopify.app.toml` and `shopify app deploy`.
8. **Firebase:** add `app.example.com` to Authorized domains.

## Subsequent releases

1. CI green on `main`.
2. Build and push images tagged with the commit sha.
3. Run the migrate job. Migrations must be backward compatible with the previous release (expand, then contract).
4. `terraform apply -var image_tag=<sha>`; Cloud Run shifts traffic once the `/readyz` startup probe passes.
5. Rollback: re-apply the previous `image_tag`. Do not roll back migrations; ship a forward fix.

## Scaling notes

- Worker concurrency: sync 4, webhooks 10, aggregate 4 per instance. Scale instances, not concurrency: Shopify limits are per shop and the client paces itself on GraphQL cost.
- The worker runs with CPU always allocated and `min_instances=1`; it is a queue consumer, not request-driven.
