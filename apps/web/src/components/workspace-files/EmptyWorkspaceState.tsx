import type { DocumentKind } from '@kamiazya/whiteboard-model'
import EmptyMark from '../../brand/empty-mark.svg?react'

/**
 * The onboarding empty state both index pages show before a workspace has
 * any documents. It lives beside the panel but renders INSTEAD of it: a
 * three-pane browser of nothing teaches less than one sentence and two
 * buttons, and arrivals from a shared link have no other page to learn from.
 *
 * Both kinds are offered because this is the one moment a user cannot reach
 * the panel's own create buttons — an empty state that could only make a
 * canvas turned a writing-first arrival away at the door.
 */
export function EmptyWorkspaceState({
  onCreate,
  disabled,
}: {
  onCreate: (kind: DocumentKind) => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      {/* The signature as a faint watermark: an empty gallery is the
          blank board, not an error — the mark stays quiet (BRAND.md). */}
      <EmptyMark className="text-muted-foreground/30" />
      <p className="text-sm font-medium">No documents yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        A canvas is a space for notes you place and connect. Everything stays in this browser — no
        account, no upload.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onCreate('spatial')}
          className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          Create a canvas
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onCreate('markdown')}
          className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          New markdown note
        </button>
      </div>
    </div>
  )
}
