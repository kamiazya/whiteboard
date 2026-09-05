import { daemonPingResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { createPairingGrant } from '../lib/daemon-api-client.js'
import { fingerprintPublicKey } from '../lib/daemon-identity-pin.js'

/**
 * The daemon-served /pair consent page (pairing-grant flow). A hosted web
 * app top-level-navigates here with ?origin=&challenge=&state=; the user's
 * explicit Approve click — required on EVERY render, no silent branch —
 * persists an origin grant via the same-origin Bearer-gated API and sends
 * the browser back to the requesting origin carrying only a single-use
 * PKCE-bound code in the fragment (never a token).
 *
 * The requesting origin renders as a React TEXT NODE only: nothing from
 * the query string is ever interpreted as markup or a URL to follow except
 * the final redirect, which goes to the VALIDATED origin.
 */

export interface PairConsentPageProps {
  /** The R3-injected daemon token (read once by App). Absent means this
   *  page is not being served by the daemon — approving is impossible. */
  daemonToken?: string
  fetchFn?: typeof globalThis.fetch
  onNavigate?: (url: string) => void
}

type ConsentState =
  | { kind: 'prompt' }
  | { kind: 'approving' }
  | { kind: 'denied' }
  | { kind: 'failed'; detail: string }

function parsePairRequest(
  search: string,
): { origin: string; challenge: string; state: string } | null {
  const params = new URLSearchParams(search)
  const originParam = params.get('origin')
  const challenge = params.get('challenge')
  const state = params.get('state')
  if (!originParam || !challenge || !state) return null
  try {
    const url = new URL(originParam)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.origin !== originParam) return null
    return { origin: url.origin, challenge, state }
  } catch {
    return null
  }
}

export function PairConsentPage({
  daemonToken,
  fetchFn = globalThis.fetch,
  onNavigate = (url) => window.location.assign(url),
}: PairConsentPageProps) {
  const location = useLocation()
  const request = useMemo(() => parsePairRequest(location.search), [location.search])
  const [consent, setConsent] = useState<ConsentState>({ kind: 'prompt' })
  // This page is daemon-served, so a same-origin ping is the daemon
  // introducing ITSELF — the trust anchor the requesting origin's pin
  // inherits via the return fragment. Failure keeps identity null (legacy
  // daemon posture): pairing still works, just unpinned.
  const [identity, setIdentity] = useState<{ publicKey: string; fingerprint: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetchFn('/api/runtime/ping')
        if (!res.ok) return
        const parsed = daemonPingResponseSchema.safeParse(await res.json())
        const publicKey = parsed.success ? parsed.data.identity?.publicKey : undefined
        if (publicKey === undefined) return
        const fingerprint = await fingerprintPublicKey(publicKey)
        if (!cancelled) setIdentity({ publicKey, fingerprint })
      } catch {
        // Legacy daemon or transient failure: proceed unpinned.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchFn])

  if (request === null) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="mb-2 text-lg font-semibold">Invalid pairing request</h1>
        <p className="text-sm text-muted-foreground">
          This page expects a pairing request from a web app (origin, challenge, and state
          parameters). Nothing was granted.
        </p>
      </main>
    )
  }

  async function approve() {
    if (daemonToken === undefined) {
      setConsent({ kind: 'failed', detail: 'this page is not being served by the daemon' })
      return
    }
    setConsent({ kind: 'approving' })
    try {
      const { code } = await createPairingGrant(fetchFn, daemonToken, {
        origin: request?.origin ?? '',
        codeChallenge: request?.challenge ?? '',
      })
      // The fragment carries only the single-use code + the caller's own
      // state nonce — never a token.
      const stateParam = encodeURIComponent(request?.state ?? '')
      const identityParam =
        identity !== null ? `&identity=${encodeURIComponent(identity.publicKey)}` : ''
      onNavigate(
        `${request?.origin}/#wb-grant=${encodeURIComponent(code)}&state=${stateParam}${identityParam}`,
      )
    } catch (error) {
      setConsent({
        kind: 'failed',
        detail: `${String(error instanceof Error ? error.message : error)}`,
      })
    }
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="mb-4 text-lg font-semibold">Allow this web app to use your local daemon?</h1>
      <p className="mb-1 text-sm text-muted-foreground">The page at</p>
      <p className="mb-1 break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm">
        {request.origin}
      </p>
      <p className="mb-4 text-sm text-muted-foreground">
        is asking to read and edit the documents stored by this daemon. Only approve origins you
        recognize.
      </p>
      {identity !== null && (
        <p className="mb-4 text-xs text-muted-foreground">
          This daemon's identity:{' '}
          <span data-testid="daemon-fingerprint" className="font-mono">
            {identity.fingerprint}
          </span>
        </p>
      )}
      {consent.kind === 'denied' ? (
        <p className="text-sm font-medium">Denied — nothing was granted. You can close this tab.</p>
      ) : consent.kind === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          Pairing failed: {consent.detail}
        </p>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={consent.kind === 'approving'}
            onClick={() => void approve()}
            className="rounded-md border bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => setConsent({ kind: 'denied' })}
            className="rounded-md border px-4 py-1.5 text-sm font-medium hover:bg-accent"
          >
            Deny
          </button>
        </div>
      )}
    </main>
  )
}
