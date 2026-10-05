import { X } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import {
  dismissWriteRefusal,
  getWriteRefusal,
  subscribeWriteRefusal,
  writeRefusalReason,
} from '../../lib/write-refusal-store.js'

/**
 * The keeper refused the last change for what it would do to the document,
 * and the page has gone back to what the keeper holds. Without this the
 * person sees their text vanish with nothing to say why — or, worse, keeps
 * typing into a copy that would never be saved.
 */
export function WriteRefusedNotice() {
  const refusal = useSyncExternalStore(subscribeWriteRefusal, getWriteRefusal)
  if (refusal === null) return null
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-chrome py-1.5 text-sm"
    >
      <p className="min-w-0 flex-1">
        <span className="font-medium">Your last change was not saved.</span>{' '}
        {writeRefusalReason(refusal)} It was undone, with anything typed after it, so the document
        shows what is saved.
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismissWriteRefusal}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  )
}
