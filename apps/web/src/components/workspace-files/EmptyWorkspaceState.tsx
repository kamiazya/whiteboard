import EmptyMark from '../../brand/empty-mark.svg?react'

/**
 * The onboarding empty state both index pages show before a workspace has
 * any documents. It lives beside the panel but renders INSTEAD of it: a
 * three-pane browser of nothing teaches less than one sentence and one
 * button, and arrivals from a shared link have no other page to learn from.
 */
export function EmptyWorkspaceState({
  onCreate,
  disabled,
}: {
  onCreate: () => void
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
      <button
        type="button"
        disabled={disabled}
        onClick={onCreate}
        className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
      >
        Create a canvas
      </button>
    </div>
  )
}
