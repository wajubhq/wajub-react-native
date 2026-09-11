import { AppState, Linking } from 'react-native';

import { PayClient } from '../client/payClient';
import { mapProcessResponse } from '../mappers/paymentMapper';
import { UNSUPPORTED_ACTION_CODE } from '../types';
import type { SessionTransaction } from '../types';
import { WajubSession } from '../WajubSession';

const txn: SessionTransaction = {
  id: 'trx.test',
  reference: 'trx.test',
  amount: 1000,
  currency: 'NGN',
  status: 'processing',
};

const clientSession = {
  id: 'prc_abc',
  provider: 'paystack',
  reference: 'prc-abc',
  amount: 100000,
  currency: 'NGN',
  hosted_url: 'https://checkout.paystack.com/abc',
  access_code: 'abc',
  public_key: 'pk_test_xxx',
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

describe('mapProcessResponse — client sessions and unsupported actions', () => {
  it('maps action client_session to requires_action with the session and its hosted_url', () => {
    const result = mapProcessResponse(
      { code: 202, status: 'Accepted', message: 'ok', action: 'client_session', client_session: clientSession, transaction: txn },
      'card',
    );

    expect(result).toEqual({
      status: 'requires_action',
      action: 'client_session',
      action_url: 'https://checkout.paystack.com/abc',
      client_session: clientSession,
      transaction: txn,
    });
  });

  it.each(['confirm_otp', 'confirm_pin', 'confirm_phone', 'confirm_birthday', 'confirm_address', 'card_reauth'])(
    'fails explicitly on %s instead of leaving the payer on an endless spinner',
    (action) => {
      const result = mapProcessResponse({ code: 202, status: 'Accepted', message: 'ok', action, transaction: txn }, 'card');

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error.code).toBe(UNSUPPORTED_ACTION_CODE);
        expect(result.error.message).toContain(action);
      }
    },
  );

  it('still treats a bare 202 without action as processing', () => {
    const result = mapProcessResponse({ code: 202, status: 'Accepted', message: 'ok', transaction: txn }, 'card');

    expect(result.status).toBe('processing');
  });
});

describe('PayClient — client session endpoints', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs /pay/client-session with only the provided options', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(202, {}));
    global.fetch = fetchMock as unknown as typeof fetch;

    await new PayClient().startClientSession('sess_1', 'card', { email: 'payer@example.test', restart: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.wajub.com/pay/client-session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ channel: 'card', email: 'payer@example.test', restart: true });
  });

  it('POSTs /pay/client-session/complete with the session id only — never a PSP reference', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, {}));
    global.fetch = fetchMock as unknown as typeof fetch;

    await new PayClient().completeClientSession('sess_1', 'prc_abc');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.wajub.com/pay/client-session/complete');
    expect(JSON.parse(init.body)).toEqual({ client_session_id: 'prc_abc' });
  });
});

describe('WajubSession.payCardHosted', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('starts the session, opens the PSP page, waits for the payer to return, then completes', async () => {
    const calls: string[] = [];
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/pay/session')) {
        return jsonResponse(200, { transaction: txn, channels: [{ id: 'c', slug: 'card', name: 'Card', type: 'card', countries: [], currency: 'NGN' }] });
      }
      if (url.endsWith('/pay/client-session')) {
        return jsonResponse(202, { code: 202, status: 'Accepted', message: 'ok', action: 'client_session', client_session: clientSession, transaction: txn });
      }
      return jsonResponse(200, { code: 200, status: 'OK', message: 'ok', transaction: { ...txn, status: 'succeeded' } });
    }) as unknown as typeof fetch;

    const openURL = jest.spyOn(Linking, 'openURL').mockImplementation(async () => {
      // The OS backgrounds the app while the PSP page is shown, then the payer returns.
      setTimeout(() => {
        (AppState as unknown as { emit(state: string): void }).emit('background');
        (AppState as unknown as { emit(state: string): void }).emit('active');
      }, 0);
    });

    const result = await new WajubSession('sess_1').payCardHosted('card', { email: 'payer@example.test' });

    expect(openURL).toHaveBeenCalledWith('https://checkout.paystack.com/abc');
    expect(calls.filter((u) => u.includes('/pay/client-session'))).toEqual([
      'https://api.wajub.com/pay/client-session',
      'https://api.wajub.com/pay/client-session/complete',
    ]);
    expect(result.status).toBe('complete');
  });
});

describe('WajubSession.payCardHosted — completion errors after the PSP page', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function stubApi(completeStatus: number, completeBody: unknown) {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/pay/session')) {
        return jsonResponse(200, { transaction: txn, channels: [] });
      }
      if (url.endsWith('/pay/client-session')) {
        return jsonResponse(202, { code: 202, status: 'Accepted', message: 'ok', action: 'client_session', client_session: clientSession, transaction: txn });
      }
      return jsonResponse(completeStatus, completeBody);
    }) as unknown as typeof fetch;
    jest.spyOn(Linking, 'openURL').mockImplementation(async () => {
      setTimeout(() => {
        (AppState as unknown as { emit(state: string): void }).emit('background');
        (AppState as unknown as { emit(state: string): void }).emit('active');
      }, 0);
    });
  }

  it('reports a verified decline (402) as failed', async () => {
    stubApi(402, { message: 'Declined', error_code: 'failed' });

    const result = await new WajubSession('sess_1').payCardHosted('card');

    expect(result.status).toBe('failed');
  });

  it('reports any other completion error as processing — the PSP webhook may still settle it', async () => {
    stubApi(500, { message: 'boom' });

    const result = await new WajubSession('sess_1').payCardHosted('card');

    expect(result.status).toBe('processing');
  });
});
