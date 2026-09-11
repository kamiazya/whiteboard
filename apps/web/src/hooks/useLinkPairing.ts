/**
 * App's side of the `#wb=` pairing link: run the resolution once per page
 * load, and put back the target the link named once the grant comes back.
 *
 * Both halves live here rather than in App because they are one concern
 * split across a navigation — the link is read before the consent hop and
 * the target arrives after it, so a reader who finds only one of them has
 * half the story.
 */
import type {
  DaemonConnectionPayload,
  DaemonConnectionTarget,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { useEffect, useRef, useState } from 'react'
import { resolveLinkPairing } from '../lib/link-pairing.js'
import type { GrantConsumeResult } from '../lib/pairing-grant.js'

export interface UseLinkPairingOptions {
  /** The `#wb=` payload, when this page load had one. */
  payload: DaemonConnectionPayload | undefined
  /** False on the daemon's own /pair route, which is not a pairing client. */
  enabled: boolean
  /** Non-null when a `#wb-grant=` return leg already owns the outcome. */
  grant: GrantConsumeResult | null
  onResolved: (grant: GrantConsumeResult) => void
  /** The link's target, once a consent round trip has carried it back. */
  onTarget: (target: DaemonConnectionTarget) => void
}

export function useLinkPairing({
  payload,
  enabled,
  grant,
  onResolved,
  onTarget,
}: UseLinkPairingOptions): { failed: boolean } {
  const [failed, setFailed] = useState(false)
  const attemptedRef = useRef(false)

  useEffect(() => {
    if (attemptedRef.current) return
    attemptedRef.current = true
    if (!enabled || payload === undefined || grant !== null) return
    void resolveLinkPairing({
      payload,
      fetch: globalThis.fetch.bind(globalThis),
      hostedOrigin: window.location.origin,
      sessionStorage: window.sessionStorage,
      navigate: (url) => {
        window.location.assign(url)
      },
    }).then((outcome) => {
      if (outcome.kind === 'resolved') onResolved(outcome.grant)
      else if (outcome.kind === 'failed') setFailed(true)
    })
    // Cold-load decision over mount-time facts; the ref guards StrictMode.
  }, [])

  // The consent round trip is a full navigation, so the `#wb=` payload that
  // named the target is gone by the time the grant resolves — the target
  // came back in the pairing transaction instead.
  useEffect(() => {
    if (grant?.status !== 'paired' || grant.target?.workspaceId === undefined) return
    onTarget(grant.target)
  }, [grant])

  return { failed }
}
