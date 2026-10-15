/**
 * The device's monotonic clock, in milliseconds: durations the SDK measures
 * (the 15-minute watch cap, the 60 s "never arrived" rule) survive the wall
 * clock being set. Never compared with a server timestamp (README §13.2).
 */
export function monotonicNow(): number {
  const performance = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}
