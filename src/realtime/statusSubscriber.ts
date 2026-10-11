import Pusher from 'pusher-js';

import { PayClient } from '../client/payClient';
import { mapStatusToResult } from '../mappers/paymentMapper';
import { API_URL } from '../types';
import type { EchoConfig, PaymentResult, SessionData } from '../types';

const TERMINAL = new Set([
  'success',
  'successful',
  'succeeded',
  'paid',
  'complete',
  'failed',
  'cancelled',
  'expired',
]);

async function pollLoop(
  client: PayClient,
  token: string,
  intervalMs: number,
  onUpdate: (result: PaymentResult) => void,
  signal: { active: boolean },
): Promise<void> {
  while (signal.active) {
    try {
      const session = await client.getSession(token);
      const result = mapStatusToResult(session.transaction.status, session.transaction);
      onUpdate(result);
      if (TERMINAL.has(session.transaction.status.toLowerCase())) {
        return;
      }
    } catch {
      /* best-effort */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Pusher/Reverb for speed, with polling running next to it for the whole watch:
 * a socket only carries what happens after it subscribed, and a connected one
 * can still miss an event.
 */
export function subscribeStatus(
  client: PayClient,
  token: string,
  session: SessionData,
  onUpdate: (result: PaymentResult) => void,
  intervalMs = 5000,
): () => void {
  const echo = session.echo;
  if (!echo) {
    const signal = { active: true };
    void pollLoop(client, token, intervalMs, onUpdate, signal);
    return () => {
      signal.active = false;
    };
  }

  return subscribePusher(client, token, session, echo, onUpdate, intervalMs);
}

function subscribePusher(
  client: PayClient,
  token: string,
  session: SessionData,
  echo: EchoConfig,
  onUpdate: (result: PaymentResult) => void,
  intervalMs: number,
): () => void {
  const wsHost = echo.ws_host.replace(/^wss?:\/\//, '');
  const forceTLS = echo.ws_host.startsWith('wss://');

  const pusher = new Pusher(echo.key, {
    cluster: 'default',
    wsHost,
    wsPort: echo.ws_port,
    wssPort: echo.ws_port,
    forceTLS,
    enabledTransports: ['ws', 'wss'],
    disableStats: true,
    // `channel_prefix` is `private-payment.` — this status channel is private,
    // so pusher-js must authorize it by proving possession of this session's
    // own bearer token, via the session-scoped authorizer endpoint.
    channelAuthorization: {
      endpoint: `${API_URL}/pay/broadcasting/auth`,
      transport: 'ajax',
      headers: { Authorization: `Bearer ${token}` },
    },
  });

  // The API publishes on the payment's Wajub id and its authorizer signs that
  // channel only. `reference` is the merchant's own: nothing is published there.
  const channelName = `${echo.channel_prefix}${session.transaction.id}`;
  const channel = pusher.subscribe(channelName);

  // Two sources for one status: a result goes out when it changes, and a final
  // one from the socket stops the polling.
  const signal = { active: true };
  let last: PaymentResult['status'] | null = null;
  const deliver = (result: PaymentResult) => {
    if (result.status === last) return;
    last = result.status;
    onUpdate(result);
  };

  channel.bind('PaymentStatusUpdated', (data: { status: string }) => {
    if (TERMINAL.has(data.status.toLowerCase())) {
      signal.active = false;
    }
    deliver(mapStatusToResult(data.status, session.transaction));
  });

  void pollLoop(
    client,
    token,
    intervalMs,
    (result) => {
      // An answer that was on its way when the polling stopped is out of date.
      if (signal.active) deliver(result);
    },
    signal,
  );

  return () => {
    signal.active = false;
    pusher.unsubscribe(channelName);
    pusher.disconnect();
  };
}
