/**
 * Structural loading state for a full canvas page: header bar + canvas
 * area placeholders instead of a lone sentence, so the page's shape is
 * stable from first paint. Announced politely to assistive tech via the
 * status role + label (the visible pulse carries no text).
 *
 * skeleton-appear keeps it invisible for a beat so a fast load never
 * flashes placeholders (see index.css).
 */
export function CanvasPageSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className="skeleton-appear flex h-full w-full flex-col"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <div className="h-5 w-36 animate-pulse rounded bg-muted" />
        <div className="ml-auto h-6 w-16 animate-pulse rounded-full bg-muted" />
        <div className="size-6 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="flex-1 p-6">
        <div className="size-full animate-pulse rounded-lg bg-muted/50" />
      </div>
    </div>
  )
}
