import type { ReactNode } from 'react'

/**
 * The full-page render of the shared `load-degraded` page state
 * (document-page-state.ts): the load itself failed and there is no
 * user-meaningful document to show. Both document pages render the state
 * through this one component, so the copy container, role and emphasis
 * cannot drift between keepers; recovery affordances are keeper-specific
 * (the browser page offers "Start fresh", the daemon page has no local
 * recovery) and travel as children.
 */
export function LoadDegradedView({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <p className="max-w-md text-sm text-destructive">{message}</p>
      {children}
    </div>
  )
}
