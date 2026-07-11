import type { DaemonProbeResult } from '../../lib/daemon-probe.js'
import type { UserSettings } from '../../lib/user-settings-store.js'

const DISMISSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Whether DaemonDetectedBanner should render for the given probe result.
 * Every unrecognized/malformed dismissal shape fails OPEN (shows the
 * banner) rather than silently hiding it — a stale or corrupt settings
 * value must never permanently suppress a real, actionable CTA.
 */
export function shouldShowDaemonCta(
  settings: UserSettings,
  probeResult: DaemonProbeResult,
  now: Date,
): boolean {
  if (!probeResult.detected) return false

  const { dismissedDaemonCtaAt, dismissedDaemonCtaInstanceId } = settings.storage
  if (dismissedDaemonCtaAt === undefined || dismissedDaemonCtaInstanceId === undefined) {
    return true
  }
  if (dismissedDaemonCtaInstanceId !== probeResult.instanceId) return true

  const dismissedAtMs = Date.parse(dismissedDaemonCtaAt)
  if (Number.isNaN(dismissedAtMs)) return true

  const ageMs = now.getTime() - dismissedAtMs
  return ageMs >= DISMISSAL_TTL_MS
}
