import { X } from 'lucide-react'

export interface CanvasNoticeProps {
  readonly notice: string | null
  readonly onDismiss: () => void
  readonly testId: string
}

/**
 * Why something the person asked the canvas for was not done, said where
 * they are looking, so no pick, drop or paste ends with nothing happening.
 */
export function CanvasNotice({ notice, onDismiss, testId }: CanvasNoticeProps) {
  return (
    // Always mounted: a live region that arrives already carrying its text
    // is announced inconsistently, one whose text changes is not. Spelled as
    // aria-live rather than role="status" so it is not a second status
    // region for a page's own one to be told apart from.
    <div aria-live="polite" aria-atomic="true" data-testid={testId} data-editor-overlay>
      {notice !== null && (
        <div className="absolute bottom-20 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-lg">
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            onClick={onDismiss}
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
