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

## 2) CDK Context (S3-backed)
The deploy workflow downloads `packages/infra/cdk.context.json` from S3:
- `s3://$SWARM_CDK_CONTEXT_BUCKET/swarm/cdk-context/staging/cdk.context.json`
- `s3://$SWARM_CDK_CONTEXT_BUCKET/swarm/cdk-context/prod/cdk.context.json`

Update those files to reflect the new domains.

Minimum keys:
- `adminDomain`: set to `staging-swarm.rati.chat` for staging, `swarm.rati.chat` for prod
- `adminCertificateArn`: ACM cert ARN in us-east-1
- `cloudflareTeamDomain`, `adminEmails` (for Cloudflare Access)

Optional (recommended) keys for future multi-stack domains:
- `domainBase`: `rati.chat`
- `stackSubdomain`: `swarm`

These allow CDK to compute the admin domain as:
- staging: `staging-<stackSubdomain>.<domainBase>`
- prod: `<stackSubdomain>.<domainBase>`

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
2. Run a CDK diff for prod locally before tagging:
   ```bash
   cd packages/infra
   npx cdk diff -c environment=prod
   ```
3. Create and push the first version tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. Watch the `Deploy` workflow for the `production` environment.

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
