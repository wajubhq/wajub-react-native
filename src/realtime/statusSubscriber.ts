import { PayClient } from '../client/payClient';
import { POLLING, StatusWatcher } from '../checkout/watcher';
import { mapStatusToResult } from '../mappers/paymentMapper';
import type { PaymentResult, PresentOptions, SessionData } from '../types';

/**
 * Watches a payment for a host that draws its own UI: `GET /pay/status` on
 * the spec's schedule (5 s, slower after 2 minutes without a change, 15 s
 * while the socket is up, backing off on errors), next to the payment's
 * private realtime channel. `onUpdate` is called when the result changes; a
 * final result — or an ended session (`401`, `410`) — stops the watch, and so
 * does the 15-minute cap. Returns a function that stops it.
 */
export function subscribeStatus(
  client: PayClient,
  token: string,
  session: SessionData,
  onUpdate: (result: PaymentResult) => void,
  intervalMs: number = POLLING.intervalMs,
  realtime?: PresentOptions['realtime'],
): () => void {
  let last: PaymentResult['status'] | null = null;
  const deliver = (result: PaymentResult) => {
    if (result.status === last) return;
    last = result.status;
    onUpdate(result);
  };
  const transaction = (status: string) => ({ ...session.transaction, status });

  const watcher = new StatusWatcher({
    client,
    token,
    // The API publishes on the payment's Wajub id; `reference` is the merchant's own.
    transactionId: session.transaction.id,
    echo: session.echo,
    realtime,
    lang: 'en',
    seenProcessing: false,
    deadline: Date.now() + POLLING.overallCapMs,
    intervalMs,
    // Finals come through onOutcome, with the spec's error codes.
    onStatus: (status) => {
      const result = mapStatusToResult(status.status, transaction(status.status));
      if (result.status === 'processing') deliver(result);
    },
    onOutcome: (outcome) => {
      if (outcome.kind === 'success') deliver({ status: 'complete', transaction: transaction('succeeded') });
      else if (outcome.kind !== 'cap') deliver({ status: 'failed', error: outcome.error, transaction: session.transaction });
    },
  });
  watcher.start();
  return () => watcher.stop();
}
