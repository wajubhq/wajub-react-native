import { buildStripeCardRequest } from '../adapters/stripeAdapter';

describe('stripeAdapter', () => {
  it('builds stripe card payload', () => {
    const data = buildStripeCardRequest('pm_test_123', 'Jane Doe');
    expect(data.payment_method_id).toBe('pm_test_123');
    expect(data.card_holder).toBe('Jane Doe');
  });
});
