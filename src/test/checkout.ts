import { CheckoutController } from '../checkout/controller';
import type { ControllerDeps } from '../checkout/controller';
import { PayClient } from '../client/payClient';
import type { PresentOptions } from '../types';

/** A sheet's controller on the fake API: no waits between retries, a browser that always opens. */
export function makeController(options: Partial<PresentOptions> = {}, deps: ControllerDeps = {}) {
  const openUrl = jest.fn(async (_url: string) => true);
  const controller = new CheckoutController(
    { sessionToken: 'tok_test', readyTimeout: 0, autoCloseSuccess: 0, ...options },
    { client: new PayClient({ sleep: async () => undefined }), openUrl, stripeInstalled: true, ...deps },
  );
  return { controller, openUrl };
}
