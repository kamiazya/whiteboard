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

  return (
    <div role="status" aria-live="polite" className="pwa-update-toast">
      <span>Update available</span>
      <button type="button" onClick={onReload}>
        Reload
      </button>
      <button
        type="button"
        onClick={() => {
          setDismissed(true)
          onDismiss()
        }}
      >
        Dismiss
      </button>
    </div>
  )
}
