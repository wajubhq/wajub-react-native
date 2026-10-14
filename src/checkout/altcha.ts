import { sha256Hex } from '../crypto';
import type { AltchaChallenge, AltchaSolution } from '../types';

/** Hashes between two yields to the JS thread (a few ms on a low-end phone), so typing stays smooth. */
const BATCH = 250;

/**
 * Finds `n` in [0, maxnumber] with lowercase_hex(SHA-256(salt + n)) ==
 * challenge (spec README §15), in batches that yield to the event loop.
 * Null when there is none, the algorithm is not SHA-256, or `signal` aborts.
 */
export async function solveAltcha(challenge: AltchaChallenge, signal?: { aborted: boolean }): Promise<AltchaSolution | null> {
  if (challenge.algorithm.toUpperCase() !== 'SHA-256') return null;
  const target = challenge.challenge.toLowerCase();
  for (let n = 0; n <= challenge.maxnumber; n++) {
    if (sha256Hex(`${challenge.salt}${n}`) === target) {
      return {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number: n,
        salt: challenge.salt,
        signature: challenge.signature,
      };
    }
    if (n % BATCH === BATCH - 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) return null;
    }
  }
  return null;
}
