import { PayClient } from '../client/payClient';
import { POLLING, StatusWatcher } from '../checkout/watcher';
import type { WatchOutcome } from '../checkout/watcher';
import { mapStatusToResult } from '../mappers/paymentMapper';
import type { PaymentResult, SessionData, SessionTransaction } from '../types';

/** 1.4's final statuses. */
const SUCCESS = ['success', 'successful', 'succeeded', 'paid', 'complete'];
const ENDED = ['failed', 'cancelled', 'expired'];

/**
 * Reports a payment's status to an app that draws its own screens, as 1.4
 * did: `onUpdate` gets `mapStatusToResult()` of the status right away, then
 * of its changes, at least every `intervalMs`. It runs until a final status,
 * a session that has ended (a `failed` result with its error), or until the
 * returned function is called.
 */
export function subscribeStatus(
  client: PayClient,
  token: string,
  session: SessionData,
  onUpdate: (result: PaymentResult) => void,
  intervalMs: number = POLLING.intervalMs,
): () => void {
  // 1.4 told every poll when it only polled, and each change once with a socket beside the polls.
  const dedup = Boolean(session.echo);
  let last: PaymentResult['status'] | null = null;
  const deliver = (result: PaymentResult) => {
    if (dedup && result.status === last) return;
    last = result.status;
    onUpdate(result);
  };
  // The session as last read: polls bring the whole transaction, as in 1.4.
  let transaction: SessionTransaction = session.transaction;

  const watcher = new StatusWatcher({
    client,
    token,
    // The API publishes on the payment's Wajub id; `reference` is the merchant's own.
    transactionId: session.transaction.id,
    echo: session.echo,
    lang: 'en',
    seenProcessing: false,
    deadline: Infinity,
    pollImmediately: true,
    intervalMs,
    read: async () => {
      const fresh = await client.getSession(token);
      transaction = fresh.transaction;
      return { reference: fresh.transaction.id, status: fresh.transaction.status };
    },
    decide: (status): WatchOutcome | null => {
      const s = status.status.toLowerCase();
      if (SUCCESS.includes(s)) return { kind: 'success' };
      return ENDED.includes(s) ? { kind: 'ended' } : null;
    },
    onStatus: (status) => deliver(mapStatusToResult(status.status, { ...transaction, status: status.status })),
    onOutcome: (outcome) => {
      if (outcome.kind === 'failed' || outcome.kind === 'expired') {
        deliver({ status: 'failed', error: outcome.cause ?? outcome.error, transaction });
      }
    },
  });
  watcher.start();
  return () => watcher.stop();
}
