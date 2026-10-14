import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { CheckoutController } from './checkout/controller';
import { stripeInstalled } from './components/StripeCardSection';
import { CheckoutSheet } from './ui/CheckoutSheet';
import { createSession, WajubSession } from './WajubSession';
import { WajubError } from './WajubError';
import type { CheckoutResult, PaymentResult, PresentOptions } from './types';

interface WajubContextValue {
  createSession: (token: string) => WajubSession;
}

const WajubContext = createContext<WajubContextValue | null>(null);

export interface WajubProviderProps {
  children: React.ReactNode;
}

/** Optional root provider — sessions are created per payment via [usePayment]. */
export function WajubProvider({ children }: WajubProviderProps) {
  const value = useMemo<WajubContextValue>(
    () => ({
      createSession: (token: string) => createSession(token),
    }),
    [],
  );
  return <WajubContext.Provider value={value}>{children}</WajubContext.Provider>;
}

function useWajubContext(): WajubContextValue {
  const ctx = useContext(WajubContext);
  return ctx ?? { createSession };
}

/** The sheet open in the app: one at a time. */
let openSheet: CheckoutController | null = null;

function openController(session: WajubSession, options: PresentOptions): CheckoutController {
  const controller = new CheckoutController(options, { client: session.transport.client, stripeInstalled });
  openSheet = controller;
  void controller.result.then(() => {
    if (openSheet === controller) openSheet = null;
  });
  return controller;
}

/**
 * `present()` opens the payment sheet and resolves once, when it closes, with
 * a `CheckoutResult`: `complete`, `processing`, `failed` or `cancelled`.
 * Render `PaymentSheet` (an element) somewhere in the component that calls
 * the hook. If that component unmounts while the sheet is open, `present()`
 * still resolves: `cancelled` (`host_gone`) before any attempt, `processing`
 * once one started, `complete` after a success.
 */
export function usePayment() {
  const { createSession: factory } = useWajubContext();
  const [controller, setController] = useState<CheckoutController | null>(null);
  const current = useRef<CheckoutController | null>(null);

  // The host goes away: settle, stop watching, never cancel.
  useEffect(() => () => current.current?.hostGone(), []);

  const present = useCallback(
    (options: PresentOptions): Promise<CheckoutResult> => {
      if (openSheet) return Promise.reject(WajubError.create('sheet_already_presented'));
      const sheet = openController(factory(options.sessionToken), options);
      current.current = sheet;
      setController(sheet);
      sheet.start();
      return sheet.result.then((result) => {
        if (current.current === sheet) {
          current.current = null;
          setController(null);
        }
        return result;
      });
    },
    [factory],
  );

  const sheet = controller ? <CheckoutSheet controller={controller} /> : null;
  return { present, PaymentSheet: sheet };
}

/** A v2 result as 1.4's `PaymentResult`, for the `PaymentSheet` component's `onResult`. */
function toPaymentResult(result: Exclude<CheckoutResult, { status: 'cancelled' }>): PaymentResult {
  if (result.status === 'complete') return { status: 'complete', transaction: result.transaction };
  if (result.status === 'processing') return { status: 'processing', transaction: result.transaction! };
  return { status: 'failed', error: result.error, transaction: result.transaction };
}

export interface PaymentSheetProps {
  visible: boolean;
  session: WajubSession;
  /** The language to speak; the payment's own when absent. */
  locale?: string;
  /** Called as the payer submits a payment. */
  onSubmit: () => void;
  /** The payer closed the sheet before any attempt. The payment is left open: cancel it if you wish. */
  onDismiss: () => void;
  onResult: (result: PaymentResult) => void;
}

/**
 * @deprecated The 1.4 component, kept for code that renders it directly:
 * use `usePayment()`. It draws the v2 sheet and reports in 1.4's terms.
 */
export function PaymentSheet({ visible, session, locale, onSubmit, onDismiss, onResult }: PaymentSheetProps) {
  const [controller, setController] = useState<CheckoutController | null>(null);
  const callbacks = useRef({ onSubmit, onDismiss, onResult });
  callbacks.current = { onSubmit, onDismiss, onResult };
  const current = useRef<{ token: string; sheet: CheckoutController; run: number } | null>(null);
  const runs = useRef(0);
  const token = session.transport.token;

  useEffect(() => {
    const run = ++runs.current;
    if (!visible) return;
    let sheet = current.current?.token === token && !current.current.sheet.closed ? current.current.sheet : null;
    if (!sheet) {
      // Another payment's sheet of this component: it goes away for this one.
      if (current.current && current.current.sheet === openSheet) {
        current.current.sheet.hostGone();
        openSheet = null;
      }
      if (openSheet) return;
      sheet = openController(session, {
        sessionToken: token,
        locale,
        cancelOnDismiss: false,
        onStateChange: ({ state }) => {
          if (state === 'PROCESSING') callbacks.current.onSubmit();
        },
      });
      void sheet.result.then((result) => {
        if (result.status === 'cancelled') callbacks.current.onDismiss();
        else callbacks.current.onResult(toPaymentResult(result));
      });
      sheet.start();
    }
    current.current = { token, sheet, run };
    setController(sheet);
    const mine = sheet;
    return () => {
      // An effect run again with the same payment (StrictMode, a new `session`
      // object) keeps the sheet; hidden or unmounted, it settles.
      setTimeout(() => {
        if (current.current?.sheet !== mine || current.current.run !== run) return;
        current.current = null;
        mine.hostGone();
      }, 0);
    };
    // `session` is read through its token: a new object for the same payment changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, token, locale]);

  return controller && !controller.closed ? <CheckoutSheet controller={controller} /> : null;
}
