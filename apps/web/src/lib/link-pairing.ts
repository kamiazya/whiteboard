/**
 * Turning a `#wb=` pairing link into an actual daemon connection.
 *
 * The link names a daemon and, optionally, what to open. It carries NO
 * credential — it used to embed the daemon's own full-authority bearer
 * token, valid until rotated, in a URL that travels through chat
 * transcripts, shell history and screen shares. So arriving with one is an
 * INTENT, and this module is the step that resolves it, through exactly the
 * path the app's own connect button uses:
 *
 *   1. silent renewal, when this browser origin already holds a grant — the
 *      browser-enforced Origin header against the daemon's persisted grant
 *      is the whole credential, and the user clicks nothing;
 *   2. otherwise a top-level navigation to the daemon's own /pair consent
 *      page, which is the only place a grant is ever approved.
 *
 * The link's target rides in the pairing transaction, so it survives the
 * navigation in (2) and the app opens what the link asked for once the
 * grant comes back.
 *
 * Kept out of App.tsx so the decision can be tested without mounting the
 * app, and so a redirect is never triggered by a render.
 */
import type { DaemonConnectionPayload } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { beginPairingGrant, type GrantConsumeResult, renewPairingToken } from './pairing-grant.js'

export type LinkPairingOutcome =
  /** Resolved without leaving the page; carries the result App holds. */
  | { kind: 'resolved'; grant: GrantConsumeResult }
  /** A consent navigation was started; this document is going away. */
  | { kind: 'redirecting' }
  /** The daemon could not be reached at all. */
  | { kind: 'failed' }

export interface ResolveLinkPairingOptions {
  payload: DaemonConnectionPayload
  fetch: typeof globalThis.fetch
  hostedOrigin: string
  sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  navigate: (url: string) => void
}

export async function resolveLinkPairing({
  payload,
  fetch,
  hostedOrigin,
  sessionStorage,
  navigate,
}: ResolveLinkPairingOptions): Promise<LinkPairingOutcome> {
  const { baseUrl, workspaceId, path, fullscreen } = payload
  try {
    const renewed = await renewPairingToken({ daemonBaseUrl: baseUrl, fetch })
    // 'identity-mismatch' is a RESOLUTION, not a miss: it is the fail-closed
    // warning that this daemon's key changed, and it has its own banner.
    // Collapsing it into the consent redirect would silently re-pin the very
    // key the verification just refused.
    if (renewed.status === 'paired' || renewed.status === 'identity-mismatch') {
      return { kind: 'resolved', grant: renewed }
    }
    await beginPairingGrant({
      daemonBaseUrl: baseUrl,
      hostedOrigin,
      sessionStorage,
      navigate,
      target: { workspaceId, path, fullscreen },
    })
    return { kind: 'redirecting' }
  } catch {
    // Never leave the caller waiting: a daemon that cannot be reached has to
    // read as a failed pairing rather than a hang.
    return { kind: 'failed' }
  }
}
