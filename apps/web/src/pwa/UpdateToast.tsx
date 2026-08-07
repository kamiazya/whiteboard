import { useState } from 'react'

export interface UpdateToastProps {
  onReload: () => void
  onDismiss: () => void
}

// Prompt-based update strategy: a stale canvas editor silently swapping
// SW-controlled assets under a user mid-draw risks losing in-flight edit
// state, so the user must opt into the reload explicitly.
export function UpdateToast({ onReload, onDismiss }: UpdateToastProps) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  // Fixed + z-index, not document flow: the app shell fills 100dvh, so a
  // static element appended to <body> sits below the viewport and the
  // update prompt is never actually seen.
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-background px-4 py-2 text-sm shadow-lg"
    >
      <span>Update available</span>
      <button
        type="button"
        onClick={onReload}
        className="rounded-md border px-2 py-0.5 font-medium transition-colors hover:bg-accent"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={() => {
          setDismissed(true)
          onDismiss()
        }}
        className="rounded-md px-2 py-0.5 text-muted-foreground transition-colors hover:bg-accent"
      >
        Dismiss
      </button>
    </div>
  )
}
