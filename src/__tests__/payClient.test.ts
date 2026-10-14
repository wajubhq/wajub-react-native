import { PayClient } from '../client/payClient';
import { fakeApi } from '../test/fakeApi';

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
