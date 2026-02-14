# Production Deployment Checklist (First Release)

This repo auto-deploys:
- **staging** on pushes to `main`
- **production** on `v*` tags

This checklist is intentionally conservative for the first production deploy.

## Domains (current plan)
- Staging: `staging-swarm.rati.chat`
- Production: `swarm.rati.chat`

## 0) Preconditions (one-time)
1. CDK bootstrap in the target AWS account/region:
   ```bash
   cd packages/infra
   npx cdk bootstrap aws://ACCOUNT_ID/us-east-1
   ```
2. GitHub Actions OIDC role + `AWS_ROLE_ARN` configured (see `.github/README.md`).
3. Confirm the `production` GitHub Environment has the intended protection rules/reviewers.

## 1) Certificates (ACM)
1. Ensure an ACM cert exists in **us-east-1** that covers:
   - `swarm.rati.chat`
   - `staging-swarm.rati.chat`
   (Wildcard `*.rati.chat` is fine.)
2. Record the ARN(s) for use in CDK context:
   - `adminCertificateArn`
   - (optional) `galleryCertificateArn` if you use a custom CDN domain

## 2) CDK Context
CDK context values are passed via `-c` flags in the deploy workflow (see `deploy-cdk-reusable.yml`).
Key context values derived from workflow inputs/secrets:
- `adminDomain`: derived from `admin_url` input
- `adminCertificateArn`: from `ADMIN_CERTIFICATE_ARN` environment secret
- `environment`, `useExistingBuckets`, `skipDomainAliases`, `stackHash`: from workflow inputs

## 3) DNS / Cloudflare
1. Create DNS records:
   - `staging-swarm.rati.chat` → CNAME to the staging Admin UI CloudFront distribution domain
   - `swarm.rati.chat` → CNAME to the prod Admin UI CloudFront distribution domain
2. After first deploy, get the CloudFront target from stack outputs:
   - Export: `swarm-admin-ui-cf-domain-staging`
   - Export: `swarm-admin-ui-cf-domain-prod`

## 4) Cloudflare Access
If you’re protecting the Admin UI with Cloudflare Access:
- Add/update the Access application to include the new hostnames.
- Ensure the JWT audience/validation expectations match what the Admin API expects.

## 5) First Production Deploy Procedure
1. Deploy staging via `main` (already automatic) and verify:
   - `https://staging-swarm.rati.chat` loads
   - `/api/*` routes work (Admin UI → Admin API)
   - Auth/session cookies work
2. (Optional) Set a temporary platform update announcement:
   - Set `SWARM_PLATFORM_NEWS` (Lambda env var) to a short Markdown-ish list.
   - Example value:
     - `- New Admin UI twitter feed view`
     - `- Fix: Twitter secrets loading fallback`
3. (Optional) Enforce a limited “control spots” model:
   - Set `SWARM_ACTIVE_USER_LIMIT=12` (Lambda env var) to restrict authenticated access to the top N most recent logins.
4. Run a CDK diff for prod locally before tagging:
   ```bash
   cd packages/infra
   npx cdk diff -c environment=prod
   ```
5. Create and push the version tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
6. Watch the `Deploy` workflow for the `production` environment.

## 6) Post-deploy Verification
- Open `https://swarm.rati.chat`
- Confirm Admin UI assets load (no mixed content, correct cache behavior)
- Confirm `/api/health` or equivalent endpoint works (and is authenticated as expected)
- Smoke test critical flows:
  - login
  - create avatar
  - update avatar config
  - logs endpoint

## Notes
- The deploy workflow treats `v*` tags as production and maps to CDK env `prod`.
- Keep production data resources on `RETAIN` removal policies; staging can be `DESTROY`.
