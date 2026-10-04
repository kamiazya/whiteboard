import { History } from 'lucide-react'
import type { ReactNode } from 'react'

export interface RestoreLockProps {
  /** Whether a restore is rewriting this document right now. */
  readonly restoring: boolean
  /** The restored version's own label, when it has one. */
  readonly label: string | null
  readonly children: ReactNode
}

/**
 * The editor's frame while the daemon restores a version of the document it
 * shows. The server tells a watching client when a restore starts and ends so
 * that nothing is typed into content that is about to be replaced; this is
 * what the client does with that.
 *
 * `inert` is what makes the editor read-only: it blocks pointer and keyboard
 * input and takes the subtree out of focus order for every editor at once,
 * where a prop would have to reach each one. The same attribute hides the
 * subtree from assistive technology, so the announcement sits OUTSIDE it.
 */
export function RestoreLock({ restoring, label, children }: RestoreLockProps) {
  return (
    <div className="relative h-full min-h-0 min-w-0">
      <div
        data-testid="restore-status"
        data-editor-overlay
        // Polite: a restore is announced once and nothing about it needs
        // to interrupt what is being read. The region is mounted before it
        // speaks (`sr-only` while idle) because one that arrives WITH its
        // message is announced inconsistently.
        role="status"
        aria-live="polite"
        className={
          restoring
            ? 'absolute top-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-lg'
            : 'sr-only'
        }
      >
        {restoring && (
          <>
            <History aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span>Restoring {label ?? 'a saved version'}…</span>
          </>
        )}
      </div>
      <div className="h-full min-h-0 min-w-0" inert={restoring}>
        {children}
      </div>
    </div>
  )
}
