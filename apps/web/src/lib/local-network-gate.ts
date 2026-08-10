// Turning the browser's local-network permission into two decisions the
// connect flow needs: whether to explain itself before the prompt appears,
// and what a failed probe actually means.
//
// The second one is why this exists. A loopback fetch that fails tells you
// nothing on its own — Chromium rejects a permission-blocked request with the
// same "Failed to fetch" as a port with nothing behind it. Reading the
// permission rules one of them out, so the UI can name a cause instead of
// listing possibilities.

import type { ProbeFailureReason } from './daemon-probe.js'
import type { LocalNetworkPermissionState } from './local-network-permission.js'

export type ConnectGate =
  /** Nothing to explain — probe now. */
  | 'probe'
  /** The prompt is still ahead: say why before it appears. */
  | 'explain'
  /** Permission denied; probing cannot succeed and will not re-prompt. */
  | 'blocked'

export interface ConnectGateInput {
  pageOriginScheme: 'http' | 'https'
  permission: LocalNetworkPermissionState
}

export function decideConnectGate({ pageOriginScheme, permission }: ConnectGateInput): ConnectGate {
  // A loopback page reaches the daemon same-origin, so no permission gates it.
  if (pageOriginScheme === 'http') return 'probe'
  if (permission === 'denied') return 'blocked'
  if (permission === 'prompt') return 'explain'
  // 'granted', and 'unknown' — an engine that does not know the feature does
  // not prompt for it, so there is no dialog to prepare the user for.
  return 'probe'
}

export type ProbeFailureExplanation =
  /**
   * The browser is not the obstacle. Deliberately not "nothing is there":
   * a running daemon that has not allowlisted this origin rejects with the
   * same "Failed to fetch" as an empty port, and no client-side signal
   * separates them. Naming only what is known keeps the UI from sending
   * someone to start a daemon that is already running.
   */
  | 'unreachable'
  /** Something answered, but it is not a whiteboard daemon. */
  | 'not-a-daemon'
  /** The browser refused to make the request. */
  | 'browser-blocked'
  /** The permission prompt was shown and left unanswered. */
  | 'permission-unanswered'
  /** Not enough information to name a cause. */
  | 'unclear'

export interface ProbeFailureInput extends ConnectGateInput {
  reason: ProbeFailureReason
}

export function explainProbeFailure({
  pageOriginScheme,
  permission,
  reason,
}: ProbeFailureInput): ProbeFailureExplanation {
  // Something answered on that port; which port it was is no longer the
  // question, so the permission has nothing to add.
  if (reason === 'http-error' || reason === 'malformed') return 'not-a-daemon'

  // Measured rather than inferred: WebKit's mixed-content rejection carries a
  // distinct message, and WebKit exposes no local-network permission to
  // corroborate it with.
  if (reason === 'blocked') return 'browser-blocked'

  if (pageOriginScheme === 'http') return 'unreachable'

  switch (permission) {
    case 'denied':
      return 'browser-blocked'
    case 'prompt':
      // The prompt fires on the request, so reaching a rejection with the
      // permission still unanswered means it was dismissed rather than denied
      // — asking again will prompt again, which no other outcome implies.
      return 'permission-unanswered'
    case 'granted':
      // The one case that used to be unanswerable. It rules the browser out;
      // it does NOT single out an empty port, because a running daemon that
      // has not allowlisted this origin fails identically here.
      return 'unreachable'
    default:
      return 'unclear'
  }
}
