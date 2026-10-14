import { PayClient } from '../client/payClient';
import { fakeApi } from '../test/fakeApi';
import { createSession } from '../WajubSession';

describe('PayClient — Authorization header', () => {
  it('sends the session token with a "Bearer " prefix (required by AuthenticatePaymentSession)', async () => {
    const api = fakeApi({ 'GET /pay/session': 'session-cm-aggregate' });
    try {
      await new PayClient().getSession('sess_abc123');

      expect(api.calls).toHaveLength(1);
      expect(api.calls[0].headers.Authorization).toBe('Bearer sess_abc123');
    } finally {
      api.restore();
    }
  });
});

describe("PayClient — 1.4's errors for the 1.4 methods", () => {
  const instant = { sleep: async () => undefined };

  it('keeps 1.4 codes and the API text, where the v2 calls use the catalogue', async () => {
    const cases: Array<[unknown, string, string, string]> = [
      [{ status: 402, body: { code: 402, message: 'Not enough money.' } }, 'insufficient_funds', 'payment_error', 'Not enough money.'],
      [{ status: 403, body: { code: 403, message: 'Merchant account suspended.' } }, 'blocked', 'payment_error', 'Merchant account suspended.'],
      [{ status: 410, body: { code: 410, error_code: 'session_expired', message: 'Expired.' } }, 'session_expired', 'authentication_error', 'Expired.'],
      [{ status: 409, body: { code: 409 } }, 'payment_error', 'payment_error', 'Request failed (409)'],
    ];
    for (const [answer, code, type, message] of cases) {
      const api = fakeApi({ 'POST /pay/process': answer as never });
      try {
        await expect(createSession('tok', new PayClient(instant)).process('cm.mtn', {})).rejects.toMatchObject({ code, type, message });
        await expect(createSession('tok', new PayClient(instant)).submit('cm.mtn', {})).rejects.not.toMatchObject({ code, type, message });
      } finally {
        api.restore();
      }
    }
    const api = fakeApi({ 'POST /pay/process': 'network' });
    try {
      // 1.4: the network's own message.
      await expect(new PayClient(instant).process('tok', 'cm.mtn', {})).rejects.toMatchObject({ code: 'network_error', message: 'Network request failed' });
      await expect(new PayClient({ ...instant, errors: 'v2' }).process('tok', 'cm.mtn', {})).rejects.toMatchObject({
        code: 'network_error',
        message: 'Connection error. Check your network.',
      });
    } finally {
      api.restore();
    }
  });

  it("returns 1.4's results from the 1.4 methods", async () => {
    const api = fakeApi({ 'GET /pay/session': 'session-cm-aggregate', 'POST /pay/process': 'process-requires-otp' });
    try {
      const session = createSession('tok', new PayClient(instant));
      // 1.4 had no screen for confirm_otp: still unsupported there; submit() reads the step.
      await expect(session.process('card', {})).resolves.toMatchObject({ status: 'failed', error: { code: 'unsupported_action' } });
      await expect(session.submit('card', {})).resolves.toMatchObject({ status: 'requires_action', action: 'confirm_otp', stepId: 'prc_7hQm2LxV9pR4sT1wYb3N' });
      // payMobileMoney sends the number as given, as 1.4 did.
      api.answer('POST /pay/process', 'process-processing-mobile-money-live');
      await session.payMobileMoney({ channel_slug: 'cm.mtn', phone: '677 12 34 56', country: 'cm' });
      expect(api.callsTo('POST /pay/process')[2].body.data).toMatchObject({ phone: '677 12 34 56', country: 'CM' });
    } finally {
      api.restore();
    }
  });
});
