/**
 * Mounted while a keeper's document list is in flight; `rows = []` alone
 * cannot say so. One component for both keepers, because the two copies
 * had already drifted: one drew the thumbnail block and one did not.
 * `.skeleton-appear` holds it invisible for 300ms, so a fast read never
 * shows it at all.
 */
export function DocumentsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading documents"
      className="skeleton-appear grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
    >
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="animate-pulse rounded-lg border p-2">
          <div className="aspect-[4/3] rounded-md bg-muted" />
          <div className="mt-2 h-4 w-2/3 rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}
