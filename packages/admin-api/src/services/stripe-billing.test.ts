import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  planFromStripePriceId,
  verifyStripeWebhookSignature,
} from './stripe-billing.js';

describe('stripe-billing', () => {
  beforeEach(() => {
    process.env.STRIPE_PRICE_ID_PRO = 'price_pro_123';
    process.env.STRIPE_PRICE_ID_ENTERPRISE = 'price_ent_456';
  });

  it('maps Stripe price IDs to plan types', () => {
    expect(planFromStripePriceId('price_pro_123')).toBe('pro');
    expect(planFromStripePriceId('price_ent_456')).toBe('enterprise');
    expect(planFromStripePriceId('price_unknown')).toBeNull();
  });

  it('verifies Stripe webhook signatures', () => {
    const secret = 'whsec_test_secret';
    const payload = JSON.stringify({ id: 'evt_123', type: 'checkout.session.completed' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`, 'utf8')
      .digest('hex');
    const header = `t=${timestamp},v1=${signature}`;

    const verified = verifyStripeWebhookSignature(payload, header, secret, timestamp * 1000);
    expect(verified).toBe(true);
  });

  it('rejects expired webhook signatures', () => {
    const secret = 'whsec_test_secret';
    const payload = JSON.stringify({ id: 'evt_123' });
    const timestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour old
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`, 'utf8')
      .digest('hex');
    const header = `t=${timestamp},v1=${signature}`;

    const verified = verifyStripeWebhookSignature(payload, header, secret, Date.now());
    expect(verified).toBe(false);
  });
});
