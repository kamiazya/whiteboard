import { History, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { UseDocumentSyncResult } from '../../hooks/useDocumentSync.js'

export interface EditorLockProps {
  /** What the session says about the document: a restore in flight, or a delete. */
  readonly sync: Pick<UseDocumentSyncResult, 'restoreInProgress' | 'restoreLabel' | 'backendError'>
  /** The way back to the workspace, offered once the document is gone. */
  readonly onLeave: (() => void) | undefined
  readonly children: ReactNode
}

/**
 * The editor's frame while its document cannot take edits: the daemon is
 * restoring a version of it, or it was deleted somewhere else — by an agent,
 * another tab, another member. The first ends on its own; the second does
 * not, since the session has stopped writing and nothing typed could be kept,
 * so its notice stays and offers the way out.
 *
 * `inert` is what makes the editor read-only: it blocks pointer and keyboard
 * input and takes the subtree out of focus order for every editor at once,
 * where a prop would have to reach each one. The same attribute hides the
 * subtree from assistive technology, so the announcement sits OUTSIDE it.
 */
export function EditorLock({ sync, onLeave, children }: EditorLockProps) {
  const restoring = sync.restoreInProgress
  const removed = documentRemoved(sync)
  return (
    <div className="relative h-full min-h-0 min-w-0">
      <div
        data-testid="restore-status"
        data-editor-overlay
        // Polite: either is announced once and nothing about it needs to
        // interrupt what is being read. The region is mounted before it
        // speaks (`sr-only` while idle) because one that arrives WITH its
        // message is announced inconsistently.
        role="status"
        aria-live="polite"
        className={
          restoring || removed
            ? 'absolute top-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-lg'
            : 'sr-only'
        }
      >
        {removed ? (
          <RemovedNotice onLeave={onLeave} />
        ) : (
          restoring && (
            <>
              <History aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span>Restoring {sync.restoreLabel ?? 'a saved version'}…</span>
            </>
          )
        )}
      </div>
      <div className="h-full min-h-0 min-w-0" inert={restoring || removed}>
        {children}
      </div>
    </div>
  )
}

/**
 * Whether the document was deleted somewhere else. The ONE predicate every
 * write surface on the page locks on — the editor here, the inspector beside
 * it, the header's rename and its menu — because the session has stopped
 * writing, and a surface left live accepts input that goes nowhere: a comment
 * leaves its box, a rename or a restore reports done, and none of it is kept.
 */
export function documentRemoved(sync: Pick<UseDocumentSyncResult, 'backendError'>): boolean {
  return sync.backendError === 'document-removed'
}

/**
 * The open inspector panel, locked with the editor while the document is gone.
 * Every panel writes the live document (comments, facets, display settings, a
 * version restore), so the slot is locked whole rather than panel by panel,
 * which would leave the next panel added live by default.
 *
 * Only on removal, not while a restore runs: the History column is where a
 * restore is watched, and that lock ends on its own.
 *
 * `contents` so the wrapper draws no box: the panel stays the row's flex item,
 * and its narrow-screen sheet stays positioned against the row. An absent
 * panel stays absent, since the shell reads "nothing to show" from it.
 */
export function lockedInspector(
  sync: Pick<UseDocumentSyncResult, 'backendError'>,
  panel: ReactNode,
): ReactNode {
  if (panel === undefined) return undefined
  return (
    <div className="contents" inert={documentRemoved(sync)}>
      {panel}
    </div>
  )
}

/** Says the document is gone and that is why nothing can be typed, with the way out. */
function RemovedNotice({ onLeave }: Readonly<{ onLeave: (() => void) | undefined }>) {
  return (
    <>
      <Trash2 aria-hidden="true" className="size-3.5 text-muted-foreground" />
      <span data-testid="document-removed-notice">
        This document was deleted elsewhere, so it can no longer be edited here.
      </span>
      {onLeave && (
        <button
          type="button"
          onClick={onLeave}
          className="rounded-md px-2 py-0.5 font-medium hover:bg-accent"
        >
          Back to documents
        </button>
      )}
    </>
  )
}
