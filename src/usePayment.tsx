import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { CheckoutController } from './checkout/controller';
import { stripeInstalled } from './components/StripeCardSection';
import { CheckoutSheet } from './ui/CheckoutSheet';
import { createSession, WajubSession } from './WajubSession';
import { WajubError } from './WajubError';
import type { CheckoutResult, PaymentResult, PresentOptions, PresentResult } from './types';

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

/** A sheet is open and has not settled. */
function sheetOpen(): boolean {
  return openSheet !== null && !openSheet.closed;
}

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
  const mounted = useRef(false);

  // The host goes away: settle, stop watching, never cancel. React may run
  // this cleanup and mount the same component again (StrictMode, a remount in
  // one commit): the sheet settles only if it did not.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current) current.current?.hostGone();
      }, 0);
    };
  }, []);

  const present = useCallback(
    (options: PresentOptions): Promise<PresentResult> => {
      if (sheetOpen()) return Promise.reject(WajubError.create('sheet_already_presented'));
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

/** An outcome as 1.4's `PaymentResult`, for the `PaymentSheet` component's `onResult`. */
function toPaymentResult(result: Extract<CheckoutResult, { status: 'complete' | 'failed' }>): PaymentResult {
  if (result.status === 'complete') return { status: 'complete', transaction: result.transaction };
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
type LegacyCallbacks = Pick<PaymentSheetProps, 'onSubmit' | 'onDismiss' | 'onResult'>;

/** Which run of a `PaymentSheet` effect holds each sheet it opened, and whose callbacks it calls. */
const legacyOwners = new Map<CheckoutController, { owner: symbol; callbacks: React.MutableRefObject<LegacyCallbacks> }>();

export function PaymentSheet({ visible, session, locale, onSubmit, onDismiss, onResult }: PaymentSheetProps) {
  const [controller, setController] = useState<CheckoutController | null>(null);
  const callbacks = useRef({ onSubmit, onDismiss, onResult });
  callbacks.current = { onSubmit, onDismiss, onResult };
  const token = session.transport.token;

  useEffect(() => {
    if (!visible) return;
    const owner = Symbol('PaymentSheet');
    // This payment's sheet, still open: an effect run again (StrictMode, a new
    // `session` object, a remount) takes it back instead of opening another.
    let sheet = openSheet && sheetOpen() && legacyOwners.has(openSheet) && openSheet.options.sessionToken === token ? openSheet : null;
    if (!sheet) {
      if (sheetOpen()) return;
      sheet = openController(session, {
        sessionToken: token,
        locale,
        cancelOnDismiss: false,
        onStateChange: ({ state }) => {
          if (state === 'PROCESSING') (legacyOwners.get(opened)?.callbacks ?? callbacks).current.onSubmit();
        },
      });
      const opened = sheet;
      // 1.4's meanings: onDismiss when the payer closed the sheet without an outcome, onResult for one.
      void opened.result.then((result) => {
        const latest = (legacyOwners.get(opened)?.callbacks ?? callbacks).current;
        legacyOwners.delete(opened);
        if (result.status === 'complete' || result.status === 'failed') latest.onResult(toPaymentResult(result));
        else latest.onDismiss();
      });
      opened.start();
    }
    legacyOwners.set(sheet, { owner, callbacks });
    setController(sheet);
    const mine = sheet;
    return () => {
      // Hidden or unmounted for good: it settles — unless a new run took it back first.
      setTimeout(() => {
        if (legacyOwners.get(mine)?.owner !== owner) return;
        legacyOwners.delete(mine);
        mine.hostGone();
      }, 0);
    };
    // `session` is read through its token: a new object for the same payment changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, token, locale]);

  return controller && !controller.closed ? <CheckoutSheet controller={controller} /> : null;
}
