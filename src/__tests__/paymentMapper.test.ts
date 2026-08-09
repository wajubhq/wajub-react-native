import { buildMobileMoneyRequest, mapProcessResponse } from '../mappers/paymentMapper';
import type { SessionTransaction } from '../types';

describe('paymentMapper', () => {
  it('maps mobile money process to push approval', () => {
    const txn: SessionTransaction = {
      id: 'trx.test',
      reference: 'trx.test',
      amount: 1000,
      currency: 'XAF',
      status: 'processing',
      processing_context: {
        is_mobile_money: true,
        payer_instruction: 'Confirm on your phone',
      },
    };

    const result = mapProcessResponse(
      {
        code: 202,
        status: 'Accepted',
        message: 'Processing',
        transaction: txn,
      },
      'mobile_money',
    );

    expect(result.status).toBe('requires_action');
    if (result.status === 'requires_action') {
      expect(result.action).toBe('push_approval');
    }
  });

  it('builds mobile money payload', () => {
    const data = buildMobileMoneyRequest({
      channel_slug: 'cm.mtn',
      phone: '699887766',
      country: 'cm',
    });
    expect(data.phone).toBe('699887766');
    expect(data.country).toBe('CM');
  });
});
