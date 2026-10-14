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

  it('builds the mobile money payload with the number in E.164', () => {
    const data = buildMobileMoneyRequest({
      channel_slug: 'cm.mtn',
      phone: '699887766',
      country: 'cm',
    });
    expect(data).toEqual({ phone: '+237699887766', country: 'CM' });
  });

  it("keeps Côte d'Ivoire's leading 0 and sends the operator hint when given", () => {
    expect(buildMobileMoneyRequest({ channel_slug: 'cm.mobile', phone: '677 12 34 56', country: 'CM', operator: 'mtn' })).toEqual({
      phone: '+237677123456',
      country: 'CM',
      operator: 'mtn',
    });
    expect(buildMobileMoneyRequest({ channel_slug: 'ci.orange', phone: '07 01 02 03 04', country: 'CI' }).phone).toBe('+2250701020304');
  });
});
