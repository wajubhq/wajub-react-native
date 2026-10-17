import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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

/** Optional: `usePayment()` works without it. */
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

/** Hosts that went away with a sheet still to settle: `present()` settles them first. */
const goneHosts = new Set<() => void>();

/** Calls a host callback; one that throws is logged. */
function call<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch (e) {
    console.warn('[wajub] callback threw:', e);
  }
}

/**
 * `present()` opens the payment sheet and resolves once, when it closes, with
 * a `CheckoutResult`: `complete`, `processing`, `failed` or `cancelled`.
 * Render `PaymentSheet` (an element) somewhere in the component that calls
 * the hook. If that component unmounts while the sheet is open, `present()`
 * still resolves: `cancelled` (`host_gone`) before any attempt, `processing`
 * once one started, `complete` after a success. Called after it unmounted, it
 * resolves `cancelled` (`host_gone`) at once.
 */
export function usePayment() {
  const { createSession: factory } = useWajubContext();
  const [controller, setController] = useState<CheckoutController | null>(null);
  const current = useRef<CheckoutController | null>(null);
  // Set while the host is unmounted. Not before its first commit: a child's
  // effect may present before the host's own effects ran.
  const gone = useRef(false);

  // The host goes away: settle, stop watching, never cancel. React may run
  // this cleanup and mount the same component again (StrictMode): the sheet
  // settles only if it did not. A layout effect, so that a remount clears
  // `gone` before any passive effect of the tree presents.
  useLayoutEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      const settle = () => {
        goneHosts.delete(settle);
        if (gone.current) current.current?.hostGone();
      };
      goneHosts.add(settle);
      setTimeout(settle, 0);
    };
  }, []);

  const present = useCallback(
    (options: PresentOptions): Promise<PresentResult> => {
      // A host replaced in this same commit settles its sheet before this one opens.
      [...goneHosts].forEach((settle) => settle());
      if (gone.current) {
        // The host is gone (the app awaited something first): nothing to show the sheet in.
        const result: CheckoutResult = { status: 'cancelled', reason: 'host_gone', redirectUrl: null, cancelled: true };
        call(options.onCancel, { reason: result.reason, redirectUrl: null });
        call(options.onComplete, result);
        return Promise.resolve(result);
      }
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
function toPaymentResult(result: Exclude<CheckoutResult, { status: 'cancelled' }>): PaymentResult {
  if (result.status === 'complete') return { status: 'complete', transaction: result.transaction };
  if (result.status === 'processing') return { status: 'processing', transaction: result.transaction, instruction: result.instruction };
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

type LegacyCallbacks = Pick<PaymentSheetProps, 'onSubmit' | 'onDismiss' | 'onResult'>;

/** Which run of a `PaymentSheet` effect holds each sheet it opened, and whose callbacks it calls. */
const legacyOwners = new Map<CheckoutController, { owner: symbol; callbacks: React.MutableRefObject<LegacyCallbacks> }>();

/**
 * @deprecated The 1.4 component, kept for code that renders it directly:
 * use `usePayment()`. It draws the payment sheet and reports in 1.4's terms:
 * `onSubmit` as the payer pays, `onResult` with the outcome (`processing` when
 * the sheet closes during an attempt), `onDismiss` when it closes before one.
 * Made visible while another sheet is open, it opens once that one closes.
 */
export function PaymentSheet({ visible, session, locale, onSubmit, onDismiss, onResult }: PaymentSheetProps) {
  const [controller, setController] = useState<CheckoutController | null>(null);
  // Bumped when another sheet that kept this one waiting closes.
  const [waited, setWaited] = useState(0);
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
      if (openSheet && sheetOpen()) {
        // Another sheet is open: this one opens once it closes.
        let live = true;
        void openSheet.result.then(() => {
          if (live) setWaited((n) => n + 1);
        });
        return () => {
          live = false;
        };
      }
      sheet = openController(session, {
        sessionToken: token,
        locale,
        cancelOnDismiss: false,
        onStateChange: ({ state }) => {
          if (state === 'PROCESSING') (legacyOwners.get(opened)?.callbacks ?? callbacks).current.onSubmit();
        },
      });
      const opened = sheet;
      void opened.result.then((result) => {
        const latest = (legacyOwners.get(opened)?.callbacks ?? callbacks).current;
        legacyOwners.delete(opened);
        if (result.status === 'cancelled') latest.onDismiss();
        else latest.onResult(toPaymentResult(result));
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
  }, [visible, token, locale, waited]);

  return controller && !controller.closed ? <CheckoutSheet controller={controller} /> : null;
}
