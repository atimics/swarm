# Swarm Project Makefile
# Common tasks for development and deployment

.PHONY: help install build dev test lint typecheck clean secrets deploy gh-secrets

# Default target
help:
	@echo "Swarm Project Commands:"
	@echo ""
	@echo "  make install      - Install all dependencies"
	@echo "  make build        - Build all packages"
	@echo "  make dev          - Start development server (admin-ui)"
	@echo "  make test         - Run all tests"
	@echo "  make lint         - Run linter"
	@echo "  make typecheck    - Run TypeScript type checking"
	@echo "  make clean        - Clean build artifacts"
	@echo ""
	@echo "  make secrets      - Setup AWS Secrets Manager (staging)"
	@echo "  make secrets-prod - Setup AWS Secrets Manager (production)"
	@echo "  make cdkctx-pull   - Download infra context from S3 (staging)"
	@echo "  make cdkctx-push   - Upload infra context to S3 (staging)"
	@echo "  make cdkctx-pull-prod - Download infra context from S3 (production)"
	@echo "  make cdkctx-push-prod - Upload infra context to S3 (production)"
	@echo "  make gh-secrets   - Manage GitHub repository secrets (CI/CD)"
	@echo ""
	@echo "  make deploy       - Deploy to staging (via GitHub Actions)"
	@echo "  make synth        - Synthesize CDK stack"
	@echo ""

# Development
install:
	pnpm install

build:
	pnpm -r build

dev:
	cd packages/admin-ui && pnpm dev

test:
	pnpm -r test

lint:
	pnpm -r lint

typecheck:
	pnpm -r typecheck

clean:
	pnpm -r clean
	rm -rf node_modules/.cache
	find . -name "dist" -type d -prune -exec rm -rf {} \; 2>/dev/null || true
	find . -name "*.tsbuildinfo" -delete 2>/dev/null || true

# AWS Secrets
secrets:
	./scripts/setup-secrets.sh staging

secrets-prod:
	./scripts/setup-secrets.sh prod

# CDK context sync (requires SWARM_CDK_CONTEXT_BUCKET)
cdkctx-pull:
	./scripts/sync-cdk-context.sh staging pull

cdkctx-push:
	./scripts/sync-cdk-context.sh staging push

cdkctx-pull-prod:
	./scripts/sync-cdk-context.sh prod pull

cdkctx-push-prod:
	./scripts/sync-cdk-context.sh prod push

# GitHub Secrets (CI/CD)
gh-secrets:
	./scripts/setup-github-secrets.sh

# Deployment
synth:
	cd packages/infra && npx cdk synth

diff:
	cd packages/infra && npx cdk diff

# Note: Actual deployment should go through GitHub Actions
deploy:
	@echo "Deployments should go through GitHub Actions."
	@echo "Push to main branch to trigger staging deployment."
	@echo ""
	@echo "For manual CDK operations:"
	@echo "  cd packages/infra && npx cdk deploy"
