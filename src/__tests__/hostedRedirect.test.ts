import { buildHostedCardRequest, hostedCardFieldError, isHostedCardField } from '../mappers/paymentMapper';
import { WajubSession } from '../WajubSession';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

describe('hosted-redirect card billing fields (sdk-config required_fields)', () => {
  it('recognizes only the fields a hosted-redirect PSP can ask for', () => {
    expect(isHostedCardField('zip_code')).toBe(true);
    expect(isHostedCardField('card.number')).toBe(false);
  });

  it('validates required, email and 2-letter country values', () => {
    expect(hostedCardFieldError('city', '  ')).toBe('Required');
    expect(hostedCardFieldError('email', 'nope')).toBe('Invalid email');
    expect(hostedCardFieldError('email', 'payer@example.test')).toBeNull();
    expect(hostedCardFieldError('country', 'CIV')).toBe('Use the 2-letter country code');
    expect(hostedCardFieldError('country', 'ci')).toBeNull();
  });

  it('builds flat data, trimming values, upper-casing the country and dropping blanks', () => {
    expect(buildHostedCardRequest({ email: ' payer@example.test ', country: 'ci', city: '' })).toEqual({
      email: 'payer@example.test',
      country: 'CI',
    });
  });
});

describe('WajubSession.payCardHostedRedirect', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs /pay/process with the billing fields and maps the redirect to the PSP page', async () => {
    const txn = { id: 'trx.test', reference: 'trx.test', amount: 1000, currency: 'XOF', status: 'processing' };
    const fetchMock = jest.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/pay/session')) {
        return jsonResponse(200, { transaction: txn, channels: [{ id: 'c', slug: 'card', name: 'Card', type: 'card', countries: [], currency: 'XOF' }] });
      }
      return jsonResponse(202, {
        code: 202,
        status: 'Accepted',
        message: 'ok',
        action: 'redirect',
        confirm_url: 'https://checkout.cinetpay.com/payment/abc',
        transaction: txn,
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await new WajubSession('sess_1').payCardHostedRedirect('card', { email: 'payer@example.test', zip_code: '00225' });

    const processCall = fetchMock.mock.calls.find(([url]: [string]) => url.endsWith('/pay/process'));
    expect(JSON.parse(processCall[1].body)).toEqual({ channel: 'card', data: { email: 'payer@example.test', zip_code: '00225' } });
    expect(result.status).toBe('requires_action');
  });
});
