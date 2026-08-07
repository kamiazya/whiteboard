import { useEffect, useMemo, useRef, useState } from 'react'
import { deriveCapabilityTier } from '../../lib/capability-tier.js'
import {
  candidateBaseUrls,
  type DiscoveredDaemon,
  discoverDaemons,
  rememberKnownDaemon,
} from '../../lib/daemon-discovery.js'
import {
  type DaemonProbeResult,
  DEFAULT_DAEMON_BASE_URL,
  type ProbeDaemonOptions,
  probeDaemon,
} from '../../lib/daemon-probe.js'
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
  'This browser blocks the hosted app from reaching a local daemon over the network, so canvases stay saved in this browser only. Use a Chromium-based browser to connect a local daemon.'

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

// Phrased as a possibility, not a claim: the same stall also happens from
// a plain network timeout with no permission prompt involved, and this
// component has no way to distinguish the two from script.
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
}: DaemonDetectedBannerProps) {
  const [result, setResult] = useState<DaemonProbeResult | null>(null)
  // Every daemon the last sweep confirmed (dynamic ports mean there can be
  // several — one per dev worktree is the local norm). `result` above stays
  // the representative single answer the dismissal/tier logic reads.
  const [found, setFound] = useState<DiscoveredDaemon[] | null>(null)
  // Set only when the USER clicked the check and it came back empty — the
  // silent auto-probe on loopback mounts must not spawn failure copy the
  // user never asked for.
  const [manualCheckFailed, setManualCheckFailed] = useState(false)
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
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The store object identity never changes, so anything derived from it has
  // to be recomputed explicitly when we write to it — a useMemo keyed on the
  // store would keep serving pre-Forget values until a reload.
  const [storedTarget, setStoredTarget] = useState(() => {
    const { localDaemonBaseUrl, lastConnectedWorkspaceId, lastConnectedSlug } =
      settingsStore.load().storage
    return { localDaemonBaseUrl, lastConnectedWorkspaceId, lastConnectedSlug }
  })

  // Trailing slashes would otherwise produce `http://host:3099//canvas/...`.
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

  // 'http:'/'https:' -> 'http'/'https'; any other scheme (e.g. jsdom's
  // default 'about:' outside these injected-prop tests) falls back to
  // 'https' — the conservative choice since it never claims a loopback
  // path is open without evidence.
  const pageOriginScheme = locationProtocol === 'http:' ? 'http' : 'https'

  // Always paired with aborting/settling the sweep the timer belongs to, so
  // a pending hint can never outlive its own probe.
  function clearHintTimer() {
    if (hintTimerRef.current !== null) {
      clearTimeout(hintTimerRef.current)
      hintTimerRef.current = null
    }
  }

  function runProbe(forceRecheck?: boolean) {
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
    const known = settingsStore.load().storage.knownDaemonBaseUrls ?? []
    // The server side binds dynamically (findAvailablePort from 3099; dev
    // worktrees use derived ports), so a single fixed-port ping misses
    // moved daemons. Remembered baseUrls are always re-checked; the wider
    // port scan runs only on explicit user intent — the silent loopback
    // auto-probe stays narrow.
    const candidates = candidateBaseUrls({
      remembered: [...known, baseUrl],
      ...(forceRecheck ? {} : { portRangeCount: 0 }),
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
      setManualCheckFailed(Boolean(forceRecheck) && nextFound.length === 0)
      if (nextFound.length > 0) {
        // Persist every confirmed daemon, first-found ending most recent,
        // so the next visit's narrow auto-probe reaches them directly.
        settingsStore.update((current) => {
          let list = current.storage.knownDaemonBaseUrls ?? []
          for (const daemon of [...nextFound].reverse()) {
            list = rememberKnownDaemon(list, daemon.baseUrl)
          }
          return { ...current, storage: { ...current.storage, knownDaemonBaseUrls: list } }
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
        lastConnectedSlug: undefined,
      },
    }))
    setStoredTarget({
      localDaemonBaseUrl: undefined,
      lastConnectedWorkspaceId: undefined,
      lastConnectedSlug: undefined,
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
            How to connect a local daemon
          </a>
        </span>
      )}
      {showManualAffordance && (
        <button
          type="button"
          onClick={() => runProbe(true)}
          disabled={checking}
          aria-busy={checking}
          className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          Check for local daemon
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
      {showManualAffordance && manualCheckFailed && (
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
              daemon's consent page grants this origin access (a top-level navigation is not subject
              to the CORS block that hides the daemon from the check) —{' '}
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
            <>No local daemon found at {baseUrl}.</>
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
            {isPairedTarget ? (
              <>A local whiteboard daemon is running at {detectedBaseUrl}.</>
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
            aria-label="Learn more about connecting to the local daemon"
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
