import { PayClient } from '../client/payClient';
import { POLLING, StatusWatcher } from '../checkout/watcher';
import type { WatchOutcome } from '../checkout/watcher';
import { mapStatusToResult } from '../mappers/paymentMapper';
import type { PaymentResult, SessionData, SessionTransaction } from '../types';

/** 1.4's final statuses. */
const SUCCESS = ['success', 'successful', 'succeeded', 'paid', 'complete'];
const ENDED = ['failed', 'cancelled', 'expired'];

/**
 * Watches a payment for a host that draws its own UI, as 1.4 did: the
 * session is read right away and then on a schedule (`intervalMs`, slower
 * after two minutes without a change, 15 s while the realtime socket is up,
 * backing off on errors), next to the payment's private realtime channel.
 * `onUpdate` gets `mapStatusToResult()` of each status read, as 1.4 did:
 * every poll when the session has no realtime channel (`echo`), and only a
 * status that changed when it has one, the socket and the polls telling the
 * same news. A final status stops the watch. There is no time limit: it runs until a final status, or
 * until the returned function is called. An ended session (`401`, `403`,
 * `404`, `410`) stops it too, with a `failed` result carrying that error —
 * 1.4 kept polling it forever.
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
