import { WajubError } from '../WajubError';

describe('WajubError.fromHttp', () => {
  it('reads an ended session (410) as an authentication error the payer cannot retry', () => {
    const error = WajubError.fromHttp(410, 'Session expired', 'session_expired', {});

    expect(error.type).toBe('authentication_error');
    expect(error.retryable).toBe(false);
  });

  it('reads a server error as Wajub side, not as a declined payment', () => {
    const error = WajubError.fromHttp(503, 'Unavailable', 'service_unavailable', {});

    expect(error.type).toBe('api_error');
    expect(error.retryable).toBe(true);
    expect(error.decline_code).toBeNull();
  });

  it('names the refused field in param when the refusal is about one field', () => {
    expect(WajubError.fromHttp(422, 'Invalid phone', 'validation_error', { 'data.phone': 'Invalid phone number.' }).param)
      .toBe('data.phone');
    expect(WajubError.fromHttp(422, 'Two fields', 'validation_error', { phone: 'x', email: 'y' }).param).toBeNull();
  });

  it('keeps a provider decline a retryable payment error', () => {
    const error = WajubError.fromHttp(402, 'Declined', 'insufficient_funds', {});

    expect(error.type).toBe('payment_error');
    expect(error.retryable).toBe(true);
    expect(error.decline_code).toBe('insufficient_funds');
  });
});
