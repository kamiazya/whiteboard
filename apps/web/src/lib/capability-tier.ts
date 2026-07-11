import type { DaemonProbeResult, ProbeFailureReason } from './daemon-probe.js'

/**
 * Capability tier for daemon pairing, derived purely from feature probes —
 * never from User-Agent sniffing. Two independent signals decide the tier:
 *
 * 1. Page origin scheme. An http (loopback) page origin can always reach a
 *    same-scheme loopback daemon; no browser mixed-content/LNA gate applies.
 *    An https (hosted) page origin needs Local Network Access (Chromium) or
 *    a permissive mixed-content policy (Firefox) — WebKit blocks it outright
 *    (see .claude/investigation-lna-hosted-daemon-transport.md).
 * 2. The latest probeDaemon() result, which distinguishes a confirmed daemon
 *    (detected:true, or an HTTP response reason like 'http-error'/'malformed'
 *    that still proves the transport path is open) from a merely-open path
 *    ('refused' — connection refused, nothing running yet) from a
 *    browser-proven block ('blocked') from an inconclusive failure
 *    ('timeout'/'network', or no probe run yet).
 *
 * States:
 * - 'tier1-confirmed': a daemon responded (or answered with a shape proving
 *   the path is open), regardless of origin scheme.
 * - 'tier1-path-open': no daemon confirmed yet, but nothing has proven the
 *   browser can't reach one — either the page origin is http/loopback
 *   (scheme dominates: the path is inherently open there) or the probe was
 *   refused on an https origin (proves the request left the browser).
 * - 'tier2-blocked': an https origin whose probe failure was proven to be a
 *   browser-side block, not a network condition. Only this state renders the
 *   "not supported in this browser" notice — honesty requires a proven
 *   blockage, not a guess from an inconclusive failure.
 * - 'unknown': no probe has run yet, or its failure could not be attributed
 *   to either an open path or a proven block (timeout, unclassified network
 *   error). The CTA/recheck affordance stays available in this state.
 */
export type CapabilityTier = 'tier1-confirmed' | 'tier1-path-open' | 'tier2-blocked' | 'unknown'

export interface CapabilityTierInput {
  pageOriginScheme: 'http' | 'https'
  probe: DaemonProbeResult | null
}

// An HTTP response — even a non-2xx or unexpected-shape one — proves the
// transport path reached a live server, which is the strongest tier1 signal
// short of an actual detected:true.
function isProvenReachableFailure(reason: ProbeFailureReason): boolean {
  return reason === 'http-error' || reason === 'malformed'
}

export function deriveCapabilityTier({
  pageOriginScheme,
  probe,
}: CapabilityTierInput): CapabilityTier {
  if (probe?.detected === true) return 'tier1-confirmed'
  if (probe && !probe.detected && isProvenReachableFailure(probe.reason)) return 'tier1-confirmed'

  if (pageOriginScheme === 'http') return 'tier1-path-open'

  if (probe && !probe.detected) {
    switch (probe.reason) {
      case 'refused':
        return 'tier1-path-open'
      case 'blocked':
        return 'tier2-blocked'
      case 'timeout':
      case 'network':
        return 'unknown'
      case 'http-error':
      case 'malformed':
        // Unreachable: handled by isProvenReachableFailure above. Listed
        // here so adding a new ProbeFailureReason breaks this switch at
        // compile time instead of silently falling through.
        return 'tier1-confirmed'
    }
  }

  return 'unknown'
}
