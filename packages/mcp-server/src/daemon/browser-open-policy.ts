// Decision policy for whether `whiteboard daemon run` should open the
// user's default browser at its own origin once the HTTP server is
// listening. Kept as a pure function (all environment reads injected by the
// caller) so every guard can be pinned by a nearest-layer test without
// touching a real TTY, process.env, or the filesystem.
//
// Auto-opening a browser is only correct for a human running the packaged
// CLI interactively on their own machine. Every other context — CI runners,
// containers, a non-loopback bind, or an explicit opt-out — must suppress
// it, because popping a browser tab is either meaningless (no display) or
// actively wrong (server-mode, a non-loopback bind whose semantics differ)
// in those cases.

import { isLoopbackHost } from '../server/daemon-auth-binding.js'

export interface AutoOpenBrowserInput {
  /** The host the daemon actually bound to. */
  host: string
  /** process.stdout.isTTY (or an equivalent interactive-terminal check). */
  isTTY: boolean
  /** Result of a container-environment probe (Docker, Podman, etc). */
  isContainer: boolean
  /** process.env, or an override for tests. */
  env: Readonly<Record<string, string | undefined>>
  /** Resolved --no-open flag / config-file `openBrowser` / default (true). */
  openOption: boolean
}

type AutoOpenBrowserSkipReason =
  | 'opted-out'
  | 'non-interactive'
  | 'ci'
  | 'container'
  | 'non-loopback-host'

export type AutoOpenBrowserDecision =
  | { shouldOpen: true }
  | { shouldOpen: false; reason: AutoOpenBrowserSkipReason }

// Order matters: opted-out is checked first so a deliberate opt-out is
// always reported as the reason, even when other guards would also fire —
// an operator who set --no-open should not see a confusing "ci" reason
// instead of confirmation their flag was honored.
export function decideAutoOpenBrowser(input: AutoOpenBrowserInput): AutoOpenBrowserDecision {
  if (!input.openOption) {
    return { shouldOpen: false, reason: 'opted-out' }
  }
  if (!input.isTTY) {
    return { shouldOpen: false, reason: 'non-interactive' }
  }
  if (input.env.CI !== undefined) {
    return { shouldOpen: false, reason: 'ci' }
  }
  if (input.isContainer) {
    return { shouldOpen: false, reason: 'container' }
  }
  if (!isLoopbackHost(input.host)) {
    return { shouldOpen: false, reason: 'non-loopback-host' }
  }
  return { shouldOpen: true }
}
