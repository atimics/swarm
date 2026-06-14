# Hosted Pilot On Fly

This is the fastest path to a first paid hosted Swarm user: one Fly machine, one persistent volume, one manually onboarded customer.

## What This Deploys

- `Dockerfile.local` target `api`
- Admin UI served statically by the local Express server
- SQLite at `/data/swarm.db`
- Blob files at `/data/blobs`
- One always-on Fly machine
- Optional local API token gate for the pilot user

This is single-tenant. It intentionally uses the local stack, not the hosted wallet/billing multi-tenant path.

## One-Time Setup

```bash
fly auth login
fly apps create swarm-rati-pilot
fly volumes create swarm_data --app swarm-rati-pilot --region sea --size 3
```

Edit `fly.toml` if you use a different app name or region.

Generate secrets:

```bash
ADMIN_PASSWORD="$(openssl rand -base64 32)"
LOCAL_TOKEN="$(openssl rand -hex 32)"
```

Set Fly secrets:

```bash
fly secrets set \
  --app swarm-rati-pilot \
  SWARM_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  SWARM_LOCAL_API_TOKEN="$LOCAL_TOKEN" \
  OPENROUTER_API_KEY="..." \
  SWARM_ALLOWED_ORIGINS="https://swarm-rati-pilot.fly.dev"
```

Use `OPENROUTER_API_KEY` for the simplest first pilot. Add integration secrets as needed after onboarding.

## Deploy

```bash
fly deploy --app swarm-rati-pilot
fly status --app swarm-rati-pilot
fly logs --app swarm-rati-pilot
```

Smoke check:

```bash
curl -fsS https://swarm-rati-pilot.fly.dev/health
```

First admin URL for the pilot user:

```text
https://swarm-rati-pilot.fly.dev/?swarmLocalToken=<LOCAL_TOKEN>
```

The admin UI stores the token in `sessionStorage` and removes it from the URL. If the browser session is cleared, send the tokenized URL again.

## Stripe

For the first dollar, use a Stripe Payment Link rather than wiring self-serve billing:

- Product: Hosted Swarm Pilot
- Price: `$9/month`
- Mode: subscription
- Terms: founding hosted pilot, single tenant, can be cancelled any time

Keep the Stripe subscription manual for Track 1. Productized wallet auth and entitlement gates belong to Track 2.

## Pilot Message Draft

Subject: Your hosted Swarm is ready

Hey — I can host the Swarm runtime for you as a founding pilot at $9/mo.

What you get:

- A private hosted Swarm dashboard
- Your avatar state persisted on the server
- OpenRouter-backed chat to start
- Help configuring the first runtime/integrations

This is an early hosted pilot, so I’ll onboard you directly and keep the setup simple. If you’re still in, use this Stripe link:

`<STRIPE_PAYMENT_LINK>`

Once that’s active I’ll send your private Swarm URL and help you configure the first avatar.

## Operational Notes

- Backup before risky changes:

```bash
fly ssh console --app swarm-rati-pilot -C 'cp /data/swarm.db /data/swarm.db.$(date +%Y%m%d%H%M%S).bak'
```

- Download data:

```bash
fly ssh sftp shell --app swarm-rati-pilot
get /data/swarm.db ./swarm.db
```

- Rotate the access token:

```bash
LOCAL_TOKEN="$(openssl rand -hex 32)"
fly secrets set --app swarm-rati-pilot SWARM_LOCAL_API_TOKEN="$LOCAL_TOKEN"
```

Then send the new tokenized URL to the pilot user.

## Do Not Add For Track 1

- Multi-tenant wallet auth
- Self-serve Stripe webhooks
- Dedicated per-user machines
- Discord gateway replacement
- AWS/CDK resurrection
