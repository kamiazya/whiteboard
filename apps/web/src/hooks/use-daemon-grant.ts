import { useCallback, useEffect, useRef, useState } from 'react'
import {
  consumeGrantFragment,
  type GrantConsumeResult,
  parseGrantFragment,
  renewPairingToken,
} from '../lib/pairing-grant.js'
import type { ProviderState } from '../lib/provider.js'
import type { UserSettingsStore } from '../lib/user-settings-store.js'

/**
 * Which stored daemon a silent renewal may be attempted against, or `null`
 * where any gate refuses.
 *
 * ADR-0023's reconnect-without-a-redirect: a later visit to a hosted origin
 * that already holds a pairing grant reconnects on the browser-enforced
 * Origin header alone (POST /api/pairing/token, grantType 'origin'). Gated to
 * the no-fragment cold load, since an in-flight `#wb=` / `#wb-grant` flow
 * always wins.
 *
 * Exported because a TEST is the only honest way to hold a gate chain: every
 * condition here is a reason nothing was asked of any daemon, and the failure
 * of each is silence.
 */
export function storedDaemonForRenewal(gate: {
  isPairRoute: boolean
  daemonConnected: boolean
  grantConnection: GrantConsumeResult | null
  providerKind: ProviderState['kind']
  storedBaseUrl: string | undefined
}): string | null {
  if (gate.isPairRoute) return null
  if (gate.daemonConnected) return null
  if (gate.grantConnection !== null) return null
  if (gate.providerKind !== 'browser') return null
  return gate.storedBaseUrl ?? null
}

export interface DaemonGrant {
  /** The pairing grant this page holds, or `null` where there is no flow. */
  readonly grantConnection: GrantConsumeResult | null
  /** Written by `useLinkPairing`, which resolves a `#wb=` intent into a grant. */
  readonly setGrantConnection: (result: GrantConsumeResult) => void
  /** The grant narrowed to `paired`, which is what a caller can reach a daemon with. */
  readonly grantPaired: (GrantConsumeResult & { status: 'paired' }) | null
  /**
   * The stored daemon answered the silent renewal with nothing usable:
   * `'refused'` (reached, HTTP 403 — a revoked grant) or `'unreachable'` (any
   * other non-ok response, or the daemon could not be reached at all). Held so
   * the render can offer the replica read (ADR-0023) instead of silently
   * landing on the browser's own workspaces, and so the two are told apart
   * (ADR-0042 decision 4: a removed member is shown a stated ban, not a page
   * that reads like a network blip).
   */
  readonly daemonRenewal: 'refused' | 'unreachable' | null
  /** Re-run by ReplicaReadPage's Reconnect action, through the same gate. */
  readonly attemptRenewal: () => Promise<void>
  /**
   * The window where a renewal is allowed but has not yet produced an
   * outcome. Nothing downstream may conclude the browser keeps this session
   * while it is open.
   */
  readonly awaitingDaemonRenewal: boolean
}

/**
 * The pairing GRANT half of a session: the return leg from the daemon's
 * consent page, the silent renewal of a stored grant, and what the store
 * remembers of either.
 *
 * A hook rather than thirty lines in `App`, because these four pieces of
 * state are only ever read together and the gate below is the same decision
 * twice — once to attempt the renewal, once to say it is still pending.
 */
export function useDaemonGrant(input: {
  isPairRoute: boolean
  daemonConnected: boolean
  providerKind: ProviderState['kind']
  userSettingsStore: UserSettingsStore
}): DaemonGrant {
  const { userSettingsStore } = input
  // Pairing-grant return leg: a `#wb-grant=<code>&state=` fragment from the
  // daemon's /pair consent page. The exchange is async (a direct POST — the
  // token itself never rides the URL), so unlike the synchronous #wb= path
  // this resolves into state.
  const [grantConnection, setGrantConnection] = useState<GrantConsumeResult | null>(() =>
    parseGrantFragment(window.location.hash) !== null ? { status: 'none' } : null,
  )
  const [daemonRenewal, setDaemonRenewal] = useState<'refused' | 'unreachable' | null>(null)

  useGrantFragment(setGrantConnection)

  const renewalTarget = storedDaemonForRenewal({
    ...input,
    grantConnection,
    storedBaseUrl: userSettingsStore.load().storage.daemonBaseUrl,
  })

  const attemptRenewal = useCallback(async () => {
    if (renewalTarget === null) return
    const result = await renewPairingToken({
      daemonBaseUrl: renewalTarget,
      fetch: globalThis.fetch.bind(globalThis),
    })
    applyRenewal(result, { setGrantConnection, setDaemonRenewal })
  }, [renewalTarget])

  useOnMount(attemptRenewal)

  const grantPaired = grantConnection?.status === 'paired' ? grantConnection : null

  useRememberGrantDaemon(grantPaired, userSettingsStore)

  return {
    grantConnection,
    setGrantConnection,
    grantPaired,
    daemonRenewal,
    attemptRenewal,
    awaitingDaemonRenewal: renewalTarget !== null && daemonRenewal === null,
  }
}

/**
 * The pairing-grant return leg: a `#wb-grant=<code>&state=` fragment from the
 * daemon's consent page, exchanged for a grant.
 *
 * The fragment is stripped IMMEDIATELY — the code is single-use and 60s-lived,
 * but it still must not linger in the address bar or history. Runs once per
 * page load, since the fragment only exists on a fresh top-level navigation
 * back from the consent page.
 */
function useGrantFragment(onResolved: (result: GrantConsumeResult) => void): void {
  useEffect(() => {
    const hash = window.location.hash
    if (parseGrantFragment(hash) === null) return
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    )
    void consumeGrantFragment({
      hash,
      sessionStorage: window.sessionStorage,
      fetch: globalThis.fetch.bind(globalThis),
    }).then(onResolved)
  }, [])
}

/**
 * Runs `effect` exactly once per mount, ref-guarded against StrictMode's
 * double render.
 *
 * `effect` is deliberately NOT a dependency: its identity changes with the
 * values it closes over, and re-running for that would defeat the guard. The
 * caller's decision is over mount-time facts.
 */
function useOnMount(effect: () => void | Promise<void>): void {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    void effect()
  }, [])
}

/** Remembers the daemon a completed grant reached, for a later cold load. */
function useRememberGrantDaemon(
  grantPaired: { daemonBaseUrl: string } | null,
  userSettingsStore: UserSettingsStore,
): void {
  const daemonBaseUrl = grantPaired?.daemonBaseUrl
  useEffect(() => {
    if (daemonBaseUrl === undefined) return
    userSettingsStore.update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl },
    }))
  }, [daemonBaseUrl])
}

/**
 * Where a renewal's outcome lands.
 *
 * 'paired' connects; 'identity-mismatch' must ALSO land in the grant — it is
 * the fail-closed warning ("this daemon's identity changed"), and dropping it
 * here would silently swallow the whole verification. Everything else is a
 * refusal the replica read has to be able to tell apart.
 */
function applyRenewal(
  result: Awaited<ReturnType<typeof renewPairingToken>>,
  land: {
    setGrantConnection: (result: GrantConsumeResult) => void
    setDaemonRenewal: (renewal: 'refused' | 'unreachable' | null) => void
  },
): void {
  if (result.status === 'paired' || result.status === 'identity-mismatch') {
    land.setDaemonRenewal(null)
    land.setGrantConnection(result)
    return
  }
  land.setDaemonRenewal(result.status === 'refused' ? 'refused' : 'unreachable')
}
