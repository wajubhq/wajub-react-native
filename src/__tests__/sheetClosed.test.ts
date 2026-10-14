import { WajubSession } from '../WajubSession';

/**
 * A payment sheet closed before the payer submitted anything left the payment
 * open on Wajub, where the hosted checkout and the Flutter SDK cancel it.
 */
function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) };
}

describe('closing the payment sheet', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { code: 200, status: 'OK', message: 'Cancelled' }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('cancels the payment on Wajub when nothing was submitted', async () => {
    await new WajubSession('sess_1').cancelIfNothingSubmitted(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/pay\/cancel$/);
    expect(init.method).toBe('POST');
  });

  it('leaves an attempt under way alone', async () => {
    await new WajubSession('sess_1').cancelIfNothingSubmitted(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never rejects when the cancel fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { message: 'Server error' }));

    await expect(new WajubSession('sess_1').cancelIfNothingSubmitted(false)).resolves.toBeUndefined();
  });
});
