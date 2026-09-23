import { useEffect, useMemo, useRef, useState } from 'react'
import { deriveCapabilityTier } from '../../lib/capability-tier.js'
import {
  candidateBaseUrls,
  type DiscoveredDaemon,
  discoverDaemons,
  rememberKnownDaemon,
} from '../../lib/daemon-discovery.js'
import {
  challengeDaemonIdentity,
  type IdentityChallengeResult,
} from '../../lib/daemon-identity-pin.js'
import {
  type DaemonProbeResult,
  DEFAULT_DAEMON_BASE_URL,
  type ProbeDaemonOptions,
  probeDaemon,
} from '../../lib/daemon-probe.js'
import {
  decideConnectGate,
  explainProbeFailure,
  type ProbeFailureExplanation,
} from '../../lib/local-network-gate.js'
import {
  type LocalNetworkPermissionState,
  queryLocalNetworkPermission,
} from '../../lib/local-network-permission.js'
import { beginPairingGrant } from '../../lib/pairing-grant.js'
import type { UserSettingsStore } from '../../lib/user-settings-store.js'
import { shouldShowDaemonCta } from './daemon-cta-visibility.js'

// Shown only once a probe PROVES the browser blocked the request (tier
// 'tier2-blocked') — never on a merely inconclusive failure. Honesty
// discipline: an unproven guess is worse than no notice at all.
//
// This is deliberately not a dead end: the daemon serves the same app at
// its own origin, and a top-level navigation there is a normal link click,
// not a fetch — it is not subject to the mixed-content/private-network
// gate that produced this notice in the first place. The "Open the local
// app" link below is the escape hatch.
export const UNSUPPORTED_BROWSER_NOTICE =
  'This browser blocks the hosted app from reaching a daemon over the network, so documents stay kept in this browser only. Use a Chromium-based browser to connect a daemon.'

// Chrome's Local Network Access prompt lives in browser chrome, not the
// page, so a probe sweep that is merely waiting on that decision looks
// identical (from script) to one still timing out. This delay is a
// judgment call, not a measured threshold: long enough that a fast sweep
// never flashes the hint, short enough that a stalled one gets a hint
// before the user gives up and clicks again.
const LNA_HINT_DELAY_MS = 1000

interface DaemonDetectedBannerProps {
  settingsStore: UserSettingsStore
  fetch: typeof globalThis.fetch
  // Injectable for tests; production default reads window.location.protocol.
  locationProtocol?: string
  // Injectable for tests; production default is the real probeDaemon.
  probeFn?: (baseUrl: string, options: ProbeDaemonOptions) => Promise<DaemonProbeResult>
  // Injectable for tests; production default starts the pairing-grant
  // redirect (see lib/pairing-grant.ts).
  beginGrantFn?: (input: { daemonBaseUrl: string }) => Promise<void>
  // Injectable for tests; production default challenges the responder's
  // identity against the pinned key (see lib/daemon-identity-pin.ts).
  challengeFn?: (baseUrl: string) => Promise<IdentityChallengeResult>
  // Injectable for tests; production default reads the browser's
  // local-network permission (see lib/local-network-permission.ts).
  queryPermissionFn?: () => Promise<LocalNetworkPermissionState>
}

// Re-exported, not re-declared: the rows below are where the copy lives, and
// the banner's own tests and callers have always named it through here.
export { HOW_TO_CONNECT_URL, LNA_HINT_TEXT } from './daemon-detected-banner-rows.js'

import {
  DaemonPicker,
  HOW_TO_CONNECT_URL,
  LocalNetworkGateNotice,
  ManualCheckControl,
  PortField,
  ProbeFailureNotice,
  SingleDaemonBanner,
} from './daemon-detected-banner-rows.js'

/**
 * Detects a locally running daemon and offers to connect. On an http:
 * (loopback) origin the probe fires automatically on mount — same-origin
 * loopback fetches need no extra permission. On https: origins the browser's
 * Local Network Access prompt requires explicit user intent, so the probe
 * only runs from a click.
 *
 * The DOMAIN decisions — what a probe failure means, whether the browser can
 * be asked, which tier a responder earns, whether the CTA is due — are pure
 * functions in `lib/` with their own tests: `decideConnectGate`,
 * `explainProbeFailure`, `deriveCapabilityTier`, `shouldShowDaemonCta`,
 * `candidateBaseUrls`, `discoverDaemons`. What stays here is the orchestration
 * between them (which row is showing, what the port field accepts, when to
 * re-probe) and the copy that explains the outcome to the user. That is why
 * the file is long, and why moving the copy into row components of its own
 * reduces nothing a reader has to hold.
 */
export function DaemonDetectedBanner({
  settingsStore,
  fetch,
  locationProtocol = window.location.protocol,
  probeFn = probeDaemon,
  beginGrantFn = ({ daemonBaseUrl }) =>
    beginPairingGrant({
      daemonBaseUrl,
      hostedOrigin: window.location.origin,
      sessionStorage: window.sessionStorage,
      navigate: (url) => window.location.assign(url),
    }),
  challengeFn = (baseUrl) =>
    challengeDaemonIdentity({ daemonBaseUrl: baseUrl, fetch: globalThis.fetch.bind(globalThis) }),
  queryPermissionFn = () => queryLocalNetworkPermission(navigator.permissions),
}: DaemonDetectedBannerProps) {
  const [result, setResult] = useState<DaemonProbeResult | null>(null)
  // Every daemon the last sweep confirmed (dynamic ports mean there can be
  // several — one per dev worktree is the local norm). `result` above stays
  // the representative single answer the dismissal/tier logic reads.
  const [found, setFound] = useState<DiscoveredDaemon[] | null>(null)
  // Cryptographic upgrade of the trust label: when the single detected
  // responder's baseUrl carries a PIN (approved on /pair before), challenge
  // it and only then say "identity verified". 'failed' downgrades the copy
  // to the cautious form even for the paired target — a daemon we once
  // pinned must be able to answer its own challenge.
  const [identityStatus, setIdentityStatus] = useState<IdentityChallengeResult | null>(null)
  // Set only when the USER clicked the check and it came back empty — the
  // silent auto-probe on loopback mounts must not spawn failure copy the
  // user never asked for.
  const [manualCheckFailed, setManualCheckFailed] = useState(false)
  const [portInput, setPortInput] = useState('')
  const [portError, setPortError] = useState<string | null>(null)
  const [dismissedAt, setDismissedAt] = useState(
    () => settingsStore.load().storage.dismissedDaemonCtaAt,
  )
  const abortRef = useRef<AbortController | null>(null)
  // True for the whole window between a sweep starting and it settling
  // (found, failed, or blocked) — drives the disabled/"Checking…" button
  // state so a second click during the sweep is impossible instead of
  // silently deduped by the in-flight map one layer down.
  const [checking, setChecking] = useState(false)
  const [showLnaHint, setShowLnaHint] = useState(false)
  // Last read of the browser's local-network permission. Read on demand
  // rather than on mount: reading it is only useful next to a check, and a
  // mount-time read would go stale the moment the user answers the prompt.
  const [permission, setPermission] = useState<LocalNetworkPermissionState>('unknown')
  // 'explain' holds the check back until the user has read why the browser
  // is about to ask; 'blocked' replaces it entirely, because a denied
  // permission cannot be re-prompted from script.
  const [connectGate, setConnectGate] = useState<'idle' | 'explain' | 'blocked'>('idle')
  // The port the held-back check was aimed at, so acknowledging the
  // explanation resumes that check rather than a broader one.
  const [gatedTarget, setGatedTarget] = useState<string | undefined>(undefined)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The store object identity never changes, so anything derived from it has
  // to be recomputed explicitly when we write to it — a useMemo keyed on the
  // store would keep serving pre-Forget values until a reload.
  const [storedTarget, setStoredTarget] = useState(() => {
    const { daemonBaseUrl, lastConnectedWorkspaceId, lastConnectedPath } =
      settingsStore.load().storage
    return { daemonBaseUrl, lastConnectedWorkspaceId, lastConnectedPath }
  })

  // Trailing slashes would otherwise produce `http://host:3099//document/...`.
  const baseUrl = (storedTarget.daemonBaseUrl ?? DEFAULT_DAEMON_BASE_URL).replace(/\/+$/, '')

  // Whether a reconnect target was ever actually persisted (as opposed to
  // baseUrl above, which always resolves to DEFAULT_DAEMON_BASE_URL even with
  // nothing stored) — this gates whether "Forget this daemon" has anything
  // to forget.
  const hasStoredTarget = storedTarget.daemonBaseUrl !== undefined

  // Since R3 the daemon serves the canonical apps/web build at its own
  // origin with no pairing needed at all, so the primary CTA is a plain
  // top-level link rather than a pairing instruction. Deep-link to the
  // last-connected canvas when known so the link lands the user back where
  // they were instead of just the daemon's root.
  // Where the sweep actually found a daemon (dynamic ports); falls back to
  // the stored/default target while nothing is confirmed.
  const detectedBaseUrl = found?.[0]?.baseUrl ?? baseUrl

  // A responder on a loopback port is an UNPROVEN claim: any local process
  // can bind a free port and answer /api/runtime/ping with a self-asserted
  // instanceId (see the daemon-impersonation-port-squatting issue). Only a
  // baseUrl this browser has actually paired with — the user approved it on
  // that daemon's own consent page — earns the app's trust label. Everything
  // else is labelled unverified. This is presentation-level honesty, not a
  // security boundary: the durable fix is daemon->browser mutual auth.
  const isPairedTarget = detectedBaseUrl === storedTarget.daemonBaseUrl

  const detectedCount = found?.length ?? 0
  useEffect(() => {
    if (detectedCount !== 1) {
      setIdentityStatus(null)
      return
    }
    let cancelled = false
    setIdentityStatus(null)
    void challengeFn(detectedBaseUrl).then((status) => {
      if (!cancelled) setIdentityStatus(status)
    })
    return () => {
      cancelled = true
    }
    // challengeFn is an injected seam with a stable default; re-challenging
    // is keyed on WHICH daemon was detected, not the callback identity.
  }, [detectedCount, detectedBaseUrl])

  // 'http:'/'https:' -> 'http'/'https'; any other scheme (e.g. jsdom's
  // default 'about:' outside these injected-prop tests) falls back to
  // 'https' — the conservative choice since it never claims a loopback
  // path is open without evidence.
  const pageOriginScheme = locationProtocol === 'http:' ? 'http' : 'https'

  // Always paired with aborting/settling the sweep the timer belongs to, so
  // a pending hint can never outlive its own probe.
  // The only way this component reads the permission. A rejection has to
  // become 'unknown' here rather than at each call site: both callers are
  // downstream of a `setChecking(true)` or gate a piece of failure copy, so a
  // propagating rejection strands the button or silently drops the copy
  // instead of surfacing anything the user can act on.
  async function readPermission(): Promise<LocalNetworkPermissionState> {
    try {
      return await queryPermissionFn()
    } catch {
      return 'unknown'
    }
  }

  function clearHintTimer() {
    if (hintTimerRef.current !== null) {
      clearTimeout(hintTimerRef.current)
      hintTimerRef.current = null
    }
  }

  function runProbe(forceRecheck?: boolean, explicit?: string) {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setChecking(true)
    setShowLnaHint(false)
    setManualCheckFailed(false)
    clearHintTimer()
    // Only an https: origin can hit the Local Network Access prompt; a
    // loopback origin reaches the daemon same-origin with no permission gate.
    if (pageOriginScheme === 'https') {
      hintTimerRef.current = setTimeout(() => setShowLnaHint(true), LNA_HINT_DELAY_MS)
    }
    const stored = settingsStore.load().storage
    const known = stored.knownDaemonBaseUrls ?? []
    // Daemons the user disconnected from stay out of both the remembered
    // list and the scan; naming one by hand overrides that, which is the
    // only way back after a disconnect.
    const dismissed = stored.dismissedDaemonBaseUrls ?? []
    // The server side binds dynamically (findAvailablePort from 3099; dev
    // worktrees use derived ports), so a single fixed-port ping misses
    // moved daemons. Remembered baseUrls are always re-checked; the wider
    // port scan runs only on explicit user intent — the silent loopback
    // auto-probe stays narrow.
    const candidates = candidateBaseUrls({
      remembered: [...known, baseUrl],
      dismissed,
      ...(explicit === undefined ? {} : { explicit }),
    })
    discoverDaemons({
      candidates,
      fetch,
      pageOriginScheme,
      probeFn,
      forceRecheck,
      signal: controller.signal,
    }).then(({ found: nextFound, failures }) => {
      if (controller.signal.aborted) return
      clearHintTimer()
      setChecking(false)
      setShowLnaHint(false)
      setFound(nextFound)
      const first = nextFound[0]
      setResult(
        first
          ? { detected: true, instanceId: first.instanceId }
          : // Prefer a proven-blocked failure so the capability tier stays
            // honest even when another candidate merely timed out.
            (failures.find((f) => !f.detected && f.reason === 'blocked') ??
              failures[0] ??
              ({ detected: false, reason: 'network' } as const)),
      )
      if (forceRecheck && nextFound.length === 0) {
        // Re-read before the failure copy renders, never reuse the pre-probe
        // snapshot: the prompt is answered DURING the sweep, so a check that
        // began at 'prompt' and was then allowed would otherwise be explained
        // as "left unanswered" — telling the user to allow what they just did.
        void readPermission().then((settled) => {
          if (controller.signal.aborted) return
          setPermission(settled)
          setManualCheckFailed(true)
        })
      } else {
        setManualCheckFailed(false)
      }
      if (nextFound.length > 0) {
        // Persist every confirmed daemon, first-found ending most recent,
        // so the next visit's narrow auto-probe reaches them directly.
        settingsStore.update((current) => {
          let list = current.storage.knownDaemonBaseUrls ?? []
          for (const daemon of [...nextFound].reverse()) {
            list = rememberKnownDaemon(list, daemon.baseUrl)
          }
          // Finding a daemon clears its dismissal: it is here because the
          // user asked for it, so leaving the flag would drop it again on
          // the next load.
          const foundUrls = new Set(nextFound.map((daemon) => daemon.baseUrl))
          const stillDismissed = (current.storage.dismissedDaemonBaseUrls ?? []).filter(
            (entry) => !foundUrls.has(entry),
          )
          return {
            ...current,
            storage: {
              ...current.storage,
              knownDaemonBaseUrls: list,
              dismissedDaemonBaseUrls: stillDismissed,
            },
          }
        })
      }
    })
  }

  useEffect(() => {
    if (locationProtocol === 'http:') runProbe()
    return () => {
      abortRef.current?.abort()
      clearHintTimer()
    }
    // Auto-probe once on mount for the http: (loopback) path only.
  }, [locationProtocol])

  function handleDismiss() {
    if (!result?.detected) return
    const now = new Date().toISOString()
    settingsStore.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        dismissedDaemonCtaAt: now,
        dismissedDaemonCtaInstanceId: result.instanceId,
      },
    }))
    setDismissedAt(now)
  }

  // Clears the persisted reconnect target (never touches dismissal state,
  // which governs an unrelated concern) so a future load stops offering to
  // reconnect here. Also dismisses this session's banner instance
  // immediately — "forget" implies "stop asking", not just "forget for next
  // time". There is no credential to clear alongside it: unattended
  // reconnect is gone (see docs/explanation/security-model.md), so
  // reconnecting via this banner always re-pairs through a fresh #wb= link.
  function handleForget() {
    settingsStore.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        daemonBaseUrl: undefined,
        lastConnectedWorkspaceId: undefined,
        lastConnectedPath: undefined,
      },
    }))
    setStoredTarget({
      daemonBaseUrl: undefined,
      lastConnectedWorkspaceId: undefined,
      lastConnectedPath: undefined,
    })
    handleDismiss()
  }

  const tier = deriveCapabilityTier({ pageOriginScheme, probe: result })
  const showUnsupportedNotice = tier === 'tier2-blocked'
  const showManualAffordance = (result === null || !result.detected) && !showUnsupportedNotice

  // Every mutation path that affects visibility flows through `result` or
  // `dismissedAt` state, so the memo stays correct while skipping the
  // synchronous localStorage load() on unrelated re-renders.
  const showBanner = useMemo(() => {
    if (result === null || !result.detected) return false
    const currentSettings = settingsStore.load()
    return shouldShowDaemonCta(
      {
        ...currentSettings,
        storage: { ...currentSettings.storage, dismissedDaemonCtaAt: dismissedAt },
      },
      result,
      new Date(),
    )
  }, [result, settingsStore, dismissedAt])

  /** Parses the port field, or null when it is empty. Invalid input reports. */
  function enteredBaseUrl(): string | null {
    const value = portInput.trim()
    if (value === '') {
      // An empty field is a valid check of the remembered daemons, so a stale
      // complaint about a previous entry must not sit next to it.
      setPortError(null)
      return null
    }
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError('Enter a port between 1 and 65535.')
      return null
    }
    setPortError(null)
    // Loopback host fixed rather than taken from the field: a full URL would
    // let this page be aimed at an arbitrary origin, and the daemon is local.
    return `http://127.0.0.1:${port}`
  }

  async function checkNow() {
    const explicit = enteredBaseUrl()
    if (explicit === null && portInput.trim() !== '') return
    const target = explicit ?? undefined
    // Claimed before the await, not inside runProbe: reading the permission
    // is asynchronous, and across that gap the UI would otherwise still show
    // the previous attempt — a live button a second click can double-start,
    // next to a failure notice describing a check that is already being
    // replaced.
    setChecking(true)
    setManualCheckFailed(false)

    // Read the permission BEFORE probing, because probing is what triggers
    // the prompt. Afterwards is too late to explain it, and a denial that is
    // already on file makes the probe a guaranteed, unexplained failure.
    const state = await readPermission()
    setPermission(state)

    const gate = decideConnectGate({ pageOriginScheme, permission: state })
    if (gate === 'blocked') {
      setChecking(false)
      setConnectGate('blocked')
      return
    }
    if (gate === 'explain') {
      setChecking(false)
      setGatedTarget(target)
      setConnectGate('explain')
      return
    }
    setConnectGate('idle')
    runProbe(true, target)
  }

  function confirmExplainedCheck() {
    setConnectGate('idle')
    runProbe(true, gatedTarget)
  }

  const failureExplanation: ProbeFailureExplanation | null =
    result === null || result.detected
      ? null
      : explainProbeFailure({ pageOriginScheme, permission, reason: result.reason })

  const onUseHere = (daemonBaseUrl: string) => void beginGrantFn({ daemonBaseUrl })

  return (
    <>
      {showUnsupportedNotice && (
        // One flex item, not two: the parent lays its children out with a gap,
        // so a sibling anchor would read as a detached chip and could wrap onto
        // its own line, away from the sentence that explains it.
        <span className="text-xs text-muted-foreground">
          {UNSUPPORTED_BROWSER_NOTICE}{' '}
          <a
            href={HOW_TO_CONNECT_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
          >
            How to connect a daemon
          </a>
        </span>
      )}
      {showManualAffordance && (
        <ManualCheckControl
          checking={checking}
          showLnaHint={showLnaHint}
          onCheck={() => void checkNow()}
        />
      )}
      <LocalNetworkGateNotice
        connectGate={connectGate}
        onContinue={confirmExplainedCheck}
        onDismiss={() => setConnectGate('idle')}
      />
      {/* 'browser-blocked' deliberately has no branch here. Both routes to it
          are handled elsewhere already: a proven block (reason 'blocked') puts
          the capability tier at 'tier2-blocked' and renders
          UNSUPPORTED_BROWSER_NOTICE instead of this row, and a denied
          permission returns at the gate above without ever probing. A branch
          for it would be unreachable UI. */}
      {showManualAffordance && manualCheckFailed && (
        <ProbeFailureNotice
          failureExplanation={failureExplanation}
          pageOriginScheme={pageOriginScheme}
          baseUrl={baseUrl}
          onConnectAnyway={() => void beginGrantFn({ daemonBaseUrl: baseUrl })}
        />
      )}
      {!showUnsupportedNotice && (
        <PortField
          portInput={portInput}
          setPortInput={setPortInput}
          portError={portError}
          onCheck={() => void checkNow()}
        />
      )}
      {showBanner && found !== null && found.length > 1 && (
        <DaemonPicker found={found} onUseHere={onUseHere} onDismiss={handleDismiss} />
      )}
      {showBanner && (found === null || found.length <= 1) && (
        <SingleDaemonBanner
          detectedBaseUrl={detectedBaseUrl}
          isPairedTarget={isPairedTarget}
          identityStatus={identityStatus}
          hasStoredTarget={hasStoredTarget}
          onUseHere={() => onUseHere(detectedBaseUrl)}
          onForget={handleForget}
          onDismiss={handleDismiss}
        />
      )}
    </>
  )
}
