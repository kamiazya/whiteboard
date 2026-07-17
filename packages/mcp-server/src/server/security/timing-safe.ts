// Shared timing-safe string comparison for every credential comparison in
// the server (Bearer daemon token over HTTP in auth.ts, daemon token over
// the WS Sec-WebSocket-Protocol subprotocol in ws-auth.ts). A naive `===`
// or `!==` leaks, through response timing, how many leading bytes of a
// guessed credential matched the real one — irrelevant for a single
// request, but a real distinguisher across many requests from an attacker
// who controls timing measurement.

import { timingSafeEqual } from 'node:crypto'

// timingSafeEqual throws on a length mismatch, so unequal lengths are
// rejected up front — a length difference is not itself a secret worth
// protecting, only the byte content is. A same-length dummy comparison
// keeps the rejection path taking comparable time to the real compare, so
// the length short-circuit itself does not become a distinguishable timing
// signal.
export function timingSafeEqualStrings(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  if (actualBytes.length !== expectedBytes.length) {
    timingSafeEqual(actualBytes, actualBytes)
    return false
  }
  return timingSafeEqual(actualBytes, expectedBytes)
}
