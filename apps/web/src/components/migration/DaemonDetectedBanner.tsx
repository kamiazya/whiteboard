import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_DAEMON_BASE_URL,
  type DaemonProbeResult,
  probeDaemon,
  type ProbeDaemonOptions,
} from '../../lib/daemon-probe.js'
import type { UserSettingsStore } from '../../lib/user-settings-store.js'
import { shouldShowDaemonCta } from './daemon-cta-visibility.js'

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

  const baseUrl = settingsStore.load().storage.localDaemonBaseUrl ?? DEFAULT_DAEMON_BASE_URL

  function runProbe(forceRecheck?: boolean) {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    probeFn(baseUrl, { fetch, forceRecheck, signal: controller.signal }).then((next) => {
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

  const showManualAffordance = result === null || !result.detected

  const showBanner =
    result !== null &&
    result.detected &&
    shouldShowDaemonCta(
      {
        ...settingsStore.load(),
        storage: { ...settingsStore.load().storage, dismissedDaemonCtaAt: dismissedAt },
      },
      result,
      new Date(),
    )

  return (
    <>
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
          <span>
            A local whiteboard daemon is running. Connect to unlock versions, branches, and merge.
          </span>
          <a
            href={HOW_TO_CONNECT_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
          >
            Learn how to connect
          </a>
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
