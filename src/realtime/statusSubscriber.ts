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

/** Pusher/Reverb with polling fallback — mirrors checkout `realtime.ts`. */
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

  const channelName = `${echo.channel_prefix}${session.transaction.reference}`;
  const channel = pusher.subscribe(channelName);

  channel.bind('PaymentStatusUpdated', (data: { status: string }) => {
    const result = mapStatusToResult(data.status, session.transaction);
    onUpdate(result);
  });

  let pollStop: (() => void) | null = null;
  const fallbackTimer = setTimeout(() => {
    if (pusher.connection.state !== 'connected') {
      const signal = { active: true };
      void pollLoop(client, token, intervalMs, onUpdate, signal);
      pollStop = () => {
        signal.active = false;
      };
    }
  }, 10_000);

  pusher.connection.bind('connected', () => {
    clearTimeout(fallbackTimer);
    pollStop?.();
    pollStop = null;
  });

  return () => {
    clearTimeout(fallbackTimer);
    pollStop?.();
    pusher.unsubscribe(channelName);
    pusher.disconnect();
  };
}
