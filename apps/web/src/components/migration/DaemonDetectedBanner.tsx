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

// Docs are not served from apps/web (no /docs route), so the banner links to
// the source-of-truth GitHub blob rather than fabricating a local route.
export const HOW_TO_CONNECT_URL =
  'https://github.com/kamiazya/whiteboard/blob/main/docs/how-to/connect-to-local-daemon.md'

// Chrome's Local Network Access prompt lives in browser chrome, not the
// page, so a probe sweep that is merely waiting on that decision looks
// identical (from script) to one still timing out. This delay is a
// judgment call, not a measured threshold: long enough that a fast sweep
// never flashes the hint, short enough that a stalled one gets a hint
// before the user gives up and clicks again.
const LNA_HINT_DELAY_MS = 1000

// Phrased as a possibility, not a claim: the same stall also happens from a
// plain network timeout with no permission prompt involved. The permission
// read settles that afterwards, but this hint is shown WHILE the sweep is
// still outstanding, when the prompt (if any) is unanswered and there is
// still nothing to distinguish the two cases by.
export const LNA_HINT_TEXT =
  'This is taking a while — your browser may be asking for permission to reach local devices. Check for a permission prompt.'

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

/**
 * Detects a locally running daemon and offers to connect. On an http:
 * (loopback) origin the probe fires automatically on mount — same-origin
 * loopback fetches need no extra permission. On https: origins the browser's
 * Local Network Access prompt requires explicit user intent, so the probe
 * only runs from a click.
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
    const { localDaemonBaseUrl, lastConnectedWorkspaceId, lastConnectedPath } =
      settingsStore.load().storage
    return { localDaemonBaseUrl, lastConnectedWorkspaceId, lastConnectedPath }
  })

  // Trailing slashes would otherwise produce `http://host:3099//document/...`.
  const baseUrl = (storedTarget.localDaemonBaseUrl ?? DEFAULT_DAEMON_BASE_URL).replace(/\/+$/, '')

  // Whether a reconnect target was ever actually persisted (as opposed to
  // baseUrl above, which always resolves to DEFAULT_DAEMON_BASE_URL even with
  // nothing stored) — this gates whether "Forget this daemon" has anything
  // to forget.
  const hasStoredTarget = storedTarget.localDaemonBaseUrl !== undefined

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
  const isPairedTarget = detectedBaseUrl === storedTarget.localDaemonBaseUrl

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        localDaemonBaseUrl: undefined,
        lastConnectedWorkspaceId: undefined,
        lastConnectedPath: undefined,
      },
    }))
    setStoredTarget({
      localDaemonBaseUrl: undefined,
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
        <button
          type="button"
          onClick={() => void checkNow()}
          disabled={checking}
          aria-busy={checking}
          className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          Check for a daemon
        </button>
      )}
      {showManualAffordance && checking && (
        <>
          <span role="status" className="text-xs text-muted-foreground">
            Checking…
          </span>
          {showLnaHint && <span className="text-xs text-muted-foreground">{LNA_HINT_TEXT}</span>}
        </>
      )}
      {connectGate === 'explain' && (
        // Said before the check, not after: the browser's prompt is triggered
        // BY the request, and a denial is remembered, so an unexplained
        // prompt is a question the user usually gets exactly one chance to
        // answer well.
        <span
          data-testid="lna-explainer"
          // A live region rather than role="dialog": this is inline and
          // non-blocking, and an unfocused dialog is announced by nothing at
          // all — a screen reader user would meet the browser's permission
          // prompt without ever hearing the explanation meant to precede it.
          role="status"
          className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground"
        >
          Your browser is about to ask whether this site may reach devices on your local network.
          That is how it connects to the daemon running on your own machine — nothing leaves your
          computer.
          <button
            type="button"
            data-testid="lna-explainer-continue"
            onClick={confirmExplainedCheck}
            className="font-medium underline"
          >
            Continue
          </button>
          <button
            type="button"
            data-testid="lna-explainer-cancel"
            onClick={() => setConnectGate('idle')}
            className="font-medium underline"
          >
            Not now
          </button>
        </span>
      )}
      {connectGate === 'blocked' && (
        // No check is offered here on purpose: the permission cannot be
        // re-requested from script once it is denied, so a retry button would
        // do nothing but fail again. Only browser settings can undo it.
        <span
          data-testid="lna-blocked"
          role="alert"
          className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-amber-700"
        >
          Your browser is blocking this site from reaching your local network, so the daemon cannot
          be found however the port is set. Allow local network access for this site in your
          browser's site settings, then check again.{' '}
          <a
            href={HOW_TO_CONNECT_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
          >
            How to connect
          </a>
        </span>
      )}
      {/* 'browser-blocked' deliberately has no branch here. Both routes to it
          are handled elsewhere already: a proven block (reason 'blocked') puts
          the capability tier at 'tier2-blocked' and renders
          UNSUPPORTED_BROWSER_NOTICE instead of this row, and a denied
          permission returns at the gate above without ever probing. A branch
          for it would be unreachable UI. */}
      {showManualAffordance &&
        manualCheckFailed &&
        failureExplanation === 'permission-unanswered' && (
          <span
            data-testid="daemon-check-unanswered-notice"
            className="text-xs text-muted-foreground"
          >
            The browser asked for permission to reach your local network and the request was left
            unanswered. Check again and choose Allow.
          </span>
        )}
      {showManualAffordance && manualCheckFailed && failureExplanation === 'not-a-daemon' && (
        <span
          data-testid="daemon-check-wrong-server-notice"
          className="text-xs text-muted-foreground"
        >
          Something is running on that port, but it is not a whiteboard daemon. Check the port
          number.
        </span>
      )}
      {showManualAffordance &&
        manualCheckFailed &&
        (failureExplanation === 'unreachable' || failureExplanation === 'unclear') && (
          // A CORS rejection (daemon running but this origin not in its
          // WHITEBOARD_ALLOWED_WEB_ORIGINS) is indistinguishable from
          // daemon-absent at the fetch layer, so the hosted-origin copy stays
          // conditional ("if yours is running…") per the honesty discipline
          // above. Loopback origins need no allowlist entry, so they get the
          // plain not-found message.
          <span data-testid="daemon-check-failed-notice" className="text-xs text-muted-foreground">
            {pageOriginScheme === 'https' ? (
              <>
                No daemon reachable from this origin. If yours is running, approving it on the
                daemon's consent page grants this origin access (a top-level navigation is not
                subject to the CORS block that hides the daemon from the check) —{' '}
                <button
                  type="button"
                  onClick={() => void beginGrantFn({ daemonBaseUrl: baseUrl })}
                  className="font-medium underline"
                >
                  connect anyway
                </button>
                . Only approve a daemon you started yourself, or see{' '}
                <a
                  href={HOW_TO_CONNECT_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline"
                >
                  how to connect
                </a>
                .
              </>
            ) : (
              <>No daemon found at {baseUrl}.</>
            )}
          </span>
        )}
      {!showUnsupportedNotice && (
        // Always offered, never gated on a failed check. Naming a port is the
        // primary way in now that there is no port scan to stumble on one:
        // gating it on "nothing found" leaves a user connected to the wrong
        // daemon unable to name the right one, and a user whose dismissals
        // hid every candidate unable to name anything at all.
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <label htmlFor="daemon-port-input">Running on another port?</label>
          <input
            id="daemon-port-input"
            data-testid="daemon-port-input"
            type="text"
            inputMode="numeric"
            value={portInput}
            onChange={(event) => setPortInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void checkNow()
            }}
            placeholder="3099"
            className="w-16 rounded border px-1 py-0.5"
            aria-describedby={portError ? 'daemon-port-error' : undefined}
          />
          <button
            type="button"
            data-testid="daemon-port-connect"
            onClick={() => void checkNow()}
            className="font-medium underline"
          >
            Check
          </button>
          {portError && (
            <span id="daemon-port-error" role="alert" className="text-amber-700">
              {portError}
            </span>
          )}
        </span>
      )}
      {showBanner && found !== null && found.length > 1 && (
        <div
          data-testid="daemon-picker"
          className="flex shrink-0 flex-wrap items-center gap-2 bg-muted px-3 py-1.5 text-xs text-muted-foreground"
        >
          <span>{found.length} servers responded on local ports (unverified).</span>
          {found.map((daemon) => (
            // Pair IN PLACE first: leaving for the daemon's own origin is
            // the fallback, not the only way through (hosted-app-first).
            <span key={daemon.instanceId} className="flex items-center gap-1">
              <span className="font-mono">{daemon.baseUrl.replace(/^https?:\/\//, '')}</span>
              <button
                type="button"
                onClick={() => void beginGrantFn({ daemonBaseUrl: daemon.baseUrl })}
                aria-label={`Use ${daemon.baseUrl} here`}
                className="rounded-md border px-2 py-0.5 font-medium transition-colors hover:bg-accent"
              >
                Use here
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
          >
            Dismiss
          </button>
        </div>
      )}
      {showBanner && (found === null || found.length <= 1) && (
        <div
          data-testid="daemon-detected-banner"
          className="flex shrink-0 items-center justify-between gap-2 bg-muted px-3 py-1.5 text-xs text-muted-foreground"
        >
          <span>
            {isPairedTarget && identityStatus === 'verified' ? (
              <>
                A whiteboard daemon is running on this machine at {detectedBaseUrl} (identity
                verified).
              </>
            ) : isPairedTarget && identityStatus !== 'failed' ? (
              <>A whiteboard daemon is running on this machine at {detectedBaseUrl}.</>
            ) : (
              <>
                A server responded at {detectedBaseUrl} (unverified — approve it on its own page to
                confirm it is your daemon).
              </>
            )}
          </span>
          <button
            type="button"
            onClick={() => void beginGrantFn({ daemonBaseUrl: detectedBaseUrl })}
            className="rounded-md border px-3 py-1 font-medium transition-colors hover:bg-accent"
          >
            Use here
          </button>
          <a
            href={HOW_TO_CONNECT_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
            aria-label="Learn more about connecting a daemon"
          >
            Learn more
          </a>
          {hasStoredTarget && (
            <button
              type="button"
              onClick={handleForget}
              className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
            >
              Forget this daemon
            </button>
          )}
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  )
}
