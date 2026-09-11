import { isRedirectWalletChannel } from '../mappers/paymentMapper';
import type { SdkChannelConfig, SessionChannel } from '../types';
import { WajubSession } from '../WajubSession';

const djamo: SessionChannel = { id: 'd', slug: 'ci.djamo', name: 'Djamo CI', type: 'wallet', countries: ['CI'], currency: 'XOF' };
const formConfig: SdkChannelConfig = { available: true, provider: 'djamo', sdk: 'form', publishable_key: null, required_fields: [] };

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) };
}

describe('one-tap wallet channels (e.g. Djamo)', () => {
  it('accepts a form wallet with nothing to collect, and nothing else', () => {
    expect(isRedirectWalletChannel(djamo, formConfig)).toBe(true);
    expect(isRedirectWalletChannel(djamo, { ...formConfig, sdk: 'stripe_elements' })).toBe(false);
    expect(isRedirectWalletChannel(djamo, { ...formConfig, required_fields: ['phone'] })).toBe(false);
    expect(isRedirectWalletChannel(djamo, { ...formConfig, available: false })).toBe(false);
    expect(isRedirectWalletChannel({ ...djamo, type: 'mobile_money' }, formConfig)).toBe(false);
    expect(isRedirectWalletChannel(djamo, undefined)).toBe(false);
  });

  it('payWallet submits the channel with empty data and maps the redirect to the wallet page', async () => {
    const originalFetch = global.fetch;
    const txn = { id: 'trx.test', reference: 'trx.test', amount: 10000, currency: 'XOF', status: 'processing' };
    const fetchMock = jest.fn().mockImplementation(async (url: string) =>
      url.endsWith('/pay/session')
        ? jsonResponse(200, { transaction: txn, channels: [djamo] })
        : jsonResponse(202, { code: 202, status: 'Accepted', message: 'ok', action: 'redirect', confirm_url: 'https://djamo.ci/?type=payment_confirmation', transaction: txn }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await new WajubSession('sess_1').payWallet('ci.djamo');

      const processCall = fetchMock.mock.calls.find(([url]: [string]) => url.endsWith('/pay/process'));
      expect(JSON.parse(processCall[1].body)).toEqual({ channel: 'ci.djamo', data: {} });
      expect(result).toMatchObject({ status: 'requires_action', action: 'redirect', action_url: 'https://djamo.ci/?type=payment_confirmation' });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
