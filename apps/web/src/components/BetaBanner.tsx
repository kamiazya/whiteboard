import { useState } from 'react'
import type { UserSettingsStore } from '../lib/user-settings-store.js'

interface BetaBannerProps {
  store: UserSettingsStore
  // The persistence claim differs per backend (browser-only vs daemon-backed),
  // so the caller supplies the copy instead of this banner guessing it.
  message: string
}

// Thin top banner, not fixed-positioned, so it stays clear of
// BackendConfigChip's bottom-right fixed overlay in App.tsx.
export function BetaBanner({ store, message }: BetaBannerProps) {
  const [dismissedAt, setDismissedAt] = useState(() => store.load().storage.dismissedBetaBannerAt)

  if (dismissedAt !== undefined) return null

  function handleDismiss() {
    const now = new Date().toISOString()
    store.update((current) => ({
      ...current,
      storage: { ...current.storage, dismissedBetaBannerAt: now },
    }))
    setDismissedAt(now)
  }

  return (
    <div
      data-testid="beta-banner"
      className="flex shrink-0 items-center justify-between gap-2 bg-muted px-3 py-1.5 text-xs text-muted-foreground"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss beta banner"
        className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
      >
        Dismiss
      </button>
    </div>
  )
}
