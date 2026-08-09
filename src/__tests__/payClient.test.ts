import { PayClient } from '../client/payClient';

describe('PayClient — Authorization header', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends the session token with a "Bearer " prefix (required by AuthenticatePaymentSession)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '{}',
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new PayClient();
    await client.getSession('sess_abc123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sess_abc123');
  });
});
