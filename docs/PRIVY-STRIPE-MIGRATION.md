# Privy + Stripe Migration (M2)

## Decision

- Keep **Privy** for identity, embedded wallets, and wallet linking.
- Use **Stripe** for recurring subscriptions, invoices, and customer portal.
- Keep entitlements as the source of truth; Stripe webhooks sync entitlement status.

## Implemented API surface

- `POST /billing/checkout`
  - Auth: wallet/Privy session cookie.
  - Input: `avatarId`, `plan` (`pro|enterprise`), `successUrl`, `cancelUrl`.
  - Output: Stripe Checkout URL.
- `POST /billing/portal`
  - Auth: wallet/Privy session cookie.
  - Input: `avatarId`, `returnUrl`.
  - Output: Stripe customer-portal URL.
- `POST /webhook/stripe`
  - Public endpoint with Stripe signature verification.
  - Processes subscription lifecycle events and syncs entitlement state.

## Stripe event mapping

- `checkout.session.completed` -> upsert active entitlement (`entitlementSource: stripe`)
- `customer.subscription.updated` -> sync plan + status
- `customer.subscription.deleted` -> downgrade to free + cancelled
- `invoice.payment_failed` -> suspend entitlement
- `invoice.paid` -> reactivate entitlement

## Environment / context keys

- `stripeSecretKeyArn`
- `stripeWebhookSecretArn`
- `stripePriceIdPro`
- `stripePriceIdEnterprise`

See `packages/infra/cdk.context.example.json` for examples.

## Privy funding stance

Privy funding/onramp should remain optional and only be shown during web3 flows where
the wallet lacks funds (for example, mint/burn actions). It should not be part of
Stripe subscription checkout flow.
