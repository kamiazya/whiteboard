import { useEffect, useMemo, useRef, useState } from 'react'
import { deriveCapabilityTier } from '../../lib/capability-tier.js'
import {
  DEFAULT_DAEMON_BASE_URL,
  type DaemonProbeResult,
  probeDaemon,
  type ProbeDaemonOptions,
} from '../../lib/daemon-probe.js'
import type { UserSettingsStore } from '../../lib/user-settings-store.js'
import { shouldShowDaemonCta } from './daemon-cta-visibility.js'

// Shown only once a probe PROVES the browser blocked the request (tier
// 'tier2-blocked') — never on a merely inconclusive failure. Honesty
// discipline: an unproven guess is worse than no notice at all.
export const UNSUPPORTED_BROWSER_NOTICE =
  'Your browser cannot connect to a local daemon; canvases stay in this browser.'

// Docs are not served from apps/web (no /docs route), so the banner links to
// the source-of-truth GitHub blob rather than fabricating a local route.
export const HOW_TO_CONNECT_URL =
  'https://github.com/kamiazya/whiteboard/blob/main/docs/how-to/connect-to-local-daemon.md'

interface DaemonDetectedBannerProps {
  settingsStore: UserSettingsStore
  fetch: typeof globalThis.fetch
  // Injectable for tests; production default reads window.location.protocol.
  locationProtocol?: string
  // Injectable for tests; production default is the real probeDaemon.
  probeFn?: (baseUrl: string, options: ProbeDaemonOptions) => Promise<DaemonProbeResult>
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
}: DaemonDetectedBannerProps) {
  const [result, setResult] = useState<DaemonProbeResult | null>(null)
  const [dismissedAt, setDismissedAt] = useState(
    () => settingsStore.load().storage.dismissedDaemonCtaAt,
  )
  const abortRef = useRef<AbortController | null>(null)

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
  const openLocalAppUrl = useMemo(() => {
    const { lastConnectedWorkspaceId, lastConnectedSlug } = storedTarget
    if (lastConnectedWorkspaceId && lastConnectedSlug) {
      return `${baseUrl}/canvas/${encodeURIComponent(lastConnectedWorkspaceId)}/${encodeURIComponent(lastConnectedSlug)}`
    }
    return baseUrl
  }, [storedTarget, baseUrl])

  // 'http:'/'https:' -> 'http'/'https'; any other scheme (e.g. jsdom's
  // default 'about:' outside these injected-prop tests) falls back to
  // 'https' — the conservative choice since it never claims a loopback
  // path is open without evidence.
  const pageOriginScheme = locationProtocol === 'http:' ? 'http' : 'https'

  function runProbe(forceRecheck?: boolean) {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    probeFn(baseUrl, {
      fetch,
      forceRecheck,
      signal: controller.signal,
      pageOriginScheme,
    }).then((next) => {
      if (controller.signal.aborted) return
      setResult(next)
    })
  }

  useEffect(() => {
    if (locationProtocol === 'http:') runProbe()
    return () => abortRef.current?.abort()
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

  // Clears the persisted reconnect target only (never touches dismissal
  // state, which governs an unrelated concern) so a future load stops
  // offering to reconnect here. Also dismisses this session's banner
  // instance immediately — "forget" implies "stop asking", not just "forget
  // for next time".
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
        <span className="text-xs text-muted-foreground">{UNSUPPORTED_BROWSER_NOTICE}</span>
      )}
      {showManualAffordance && (
        <button
          type="button"
          onClick={() => runProbe(true)}
          className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent"
        >
          Check for local daemon
        </button>
      )}
      {showBanner && (
        <div
          data-testid="daemon-detected-banner"
          className="flex shrink-0 items-center justify-between gap-2 bg-muted px-3 py-1.5 text-xs text-muted-foreground"
        >
          <span>A local whiteboard daemon is running at {baseUrl}.</span>
          <a
            href={openLocalAppUrl}
            className="rounded-md border px-3 py-1 font-medium transition-colors hover:bg-accent"
          >
            Open the local app
          </a>
          <a
            href={HOW_TO_CONNECT_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
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
