import { handlePaymentAction } from '../actionHandler';
import type { WajubSession } from '../WajubSession';
import type { PaymentResult } from '../types';

describe('handlePaymentAction', () => {
  it('opens browser for redirect actions', async () => {
    const session = {
      handleRedirectAction: jest.fn().mockResolvedValue(true),
    } as unknown as WajubSession;

    const result: PaymentResult = {
      status: 'requires_action',
      action: 'redirect',
      action_url: 'https://psp.example/confirm',
      transaction: {
        id: 'trx',
        reference: 'trx',
        amount: 1000,
        currency: 'XAF',
        status: 'processing',
      },
    };

    await handlePaymentAction(session, result);
    expect(session.handleRedirectAction).toHaveBeenCalledWith(result);
  });

  it('passes through complete results unchanged', async () => {
    const session = { handleRedirectAction: jest.fn() } as unknown as WajubSession;
    const result: PaymentResult = {
      status: 'complete',
      transaction: {
        id: 'trx',
        reference: 'trx',
        amount: 1000,
        currency: 'XAF',
        status: 'success',
      },
    };

    const out = await handlePaymentAction(session, result);
    expect(out).toBe(result);
    expect(session.handleRedirectAction).not.toHaveBeenCalled();
  });
});
