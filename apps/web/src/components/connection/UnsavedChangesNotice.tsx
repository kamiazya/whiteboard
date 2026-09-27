import { X } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getShellConnection, subscribeShellStatus } from '../../lib/shell-status-store.js'

/**
 * A daemon-kept page whose latest changes have not reached the daemon holds
 * them in this tab's memory and nowhere else, so closing the tab loses them.
 * The shell mark's cap alone is too small to carry that, so it is said in
 * plain sight, and the browser asks before the tab goes.
 *
 * Dismissing hides the words, never the leave prompt: the changes are just as
 * unsaved once someone has read about them. The notice comes back the next
 * time changes stop landing.
 */
export function UnsavedChangesNotice() {
  const state = useSyncExternalStore(subscribeShellStatus, getShellConnection)?.state
  const holding = state?.keeper === 'daemon' && state.session === 'write-failed'
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!holding) {
      setDismissed(false)
      return
    }
    const ask = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [holding])

  if (!holding || dismissed) return null
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-amber-600/40 bg-amber-500/10 px-chrome py-1.5 text-sm">
      <p className="min-w-0 flex-1">
        <span className="font-medium">Changes not saved yet.</span> The daemon has not received your
        latest changes. They are kept in this tab and sent when it reconnects — keep this tab open
        until then.
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  )
}
