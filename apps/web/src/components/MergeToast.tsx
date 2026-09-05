import { documentsApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { CheckCircle2, Undo2, X } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { useDaemonApi } from '../contexts/DaemonApiContext.js'
import { getAppLogger } from '../lib/app-logger.js'
import { safeErrorCopy } from '../lib/error-copy.js'
import {
  MERGE_COMMITTED_EVENT,
  type MergeCommittedDetail,
  parseMergeCommittedEvent,
} from '../lib/merge-committed-event.js'
import { cn, displayBranchName } from '../lib/utils.js'
import { Button } from './ui/button.js'

const log = getAppLogger('merge-toast')

// Short-lived toast shown in the bottom-right after merge completes.
// - Content: ✓ merged source branch, summary counts, optional Undo
// - Auto-dismiss: 5 seconds by default; pause while hovered
// - Undo hides the toast immediately and restores preMergeVersionId
//
// MergeDialog dispatches whiteboard:merge_committed, and DocumentPage mounts this so it stays local to the canvas view.

export interface MergeToastProps {
  workspaceId: string
  path: string
  // Called after a successful restore so DocumentPage can clear its local undo stack.
  onRestored?: () => void
}

interface ActiveToast {
  key: number
  detail: MergeCommittedDetail
}

export function MergeToast({ workspaceId, path, onRestored }: MergeToastProps): JSX.Element | null {
  const fetchFn = useDaemonApi()
  const [active, setActive] = useState<ActiveToast | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const hoverRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (event: Event) => {
      const detail = parseMergeCommittedEvent(event)
      if (!detail) return
      if (detail.workspaceId !== workspaceId || detail.path !== path) return
      setUndoError(null)
      setActive({ key: Date.now(), detail })
    }
    window.addEventListener(MERGE_COMMITTED_EVENT, handler)
    return () => window.removeEventListener(MERGE_COMMITTED_EVENT, handler)
  }, [workspaceId, path])

  useEffect(() => {
    if (!active) return
    // Auto-close after 5 seconds. If still hovered when the timer fires, mouseleave
    // (via scheduleRef) restarts a fresh timer instead of leaving the toast stuck open.
    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        if (hoverRef.current) return
        setActive(null)
      }, 5000)
    }
    scheduleRef.current = schedule
    schedule()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [active])

  if (!active) return null

  const {
    workspaceId: mergeWorkspaceId,
    path: mergePath,
    sourceName,
    newCount,
    changedCount,
    conflictCount,
    preMergeVersionId,
    switchedHead,
    deletedSource,
  } = active.detail
  const canUndo = typeof preMergeVersionId === 'string' && preMergeVersionId.length > 0

  const handleUndo = async () => {
    if (!canUndo || undoing) return
    setUndoing(true)
    setUndoError(null)
    try {
      // Restore the canvas the merge actually happened on, not whichever
      // canvas is currently selected — the toast can outlive a canvas switch.
      const res = await fetchFn(
        documentsApiUrl(
          mergeWorkspaceId,
          mergePath,
          `versions/${encodeURIComponent(preMergeVersionId)}/restore`,
        ),
        { method: 'POST' },
      )
      if (res.ok) {
        onRestored?.()
        setActive(null)
        return
      }
      const body = await res.json().catch(() => undefined)
      const message = safeErrorCopy({ status: res.status, body }, 'Undo failed. Try again.')
      log.error('restore request failed', {
        status: res.status,
        workspaceId: mergeWorkspaceId,
        path: mergePath,
      })
      setUndoError(message)
    } catch (err) {
      // Keep the toast (and its retry affordance) visible; the restore did not happen.
      log.error('restore request threw', err, { workspaceId: mergeWorkspaceId, path: mergePath })
      setUndoError(safeErrorCopy(err, 'Undo failed. Try again.'))
    } finally {
      setUndoing(false)
    }
  }

  const handleClose = () => setActive(null)

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="merge-toast"
      onMouseEnter={() => {
        hoverRef.current = true
      }}
      onMouseLeave={() => {
        hoverRef.current = false
        scheduleRef.current()
      }}
      className={cn(
        'pointer-events-auto fixed bottom-4 right-4 z-50 flex w-[380px] max-w-[90vw] items-start gap-3',
        'rounded-lg border-2 bg-background p-3 shadow-lg',
        'border-emerald-500/60 ring-1 ring-emerald-500/20',
      )}
    >
      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-sm font-medium">
          Combined changes from «{displayBranchName(sourceName)}»
        </div>
        <div className="text-xs text-muted-foreground">
          {[
            newCount > 0 ? `${newCount} added` : null,
            changedCount > 0 ? `${changedCount} changed` : null,
            conflictCount > 0 ? `${conflictCount} needs review` : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'No content changes'}
        </div>
        {(switchedHead || deletedSource) && (
          <div className="text-[11px] text-muted-foreground/90">
            {switchedHead ? `Switched to «${displayBranchName(switchedHead.to)}»` : null}
            {switchedHead && deletedSource ? ' · ' : null}
            {deletedSource ? `Deleted «${displayBranchName(deletedSource)}»` : null}
          </div>
        )}
        {canUndo && (
          <div className="mt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={undoing}
              onClick={handleUndo}
              data-testid="merge-toast-undo"
            >
              <Undo2 className="size-3.5" />
              {undoing ? 'Undoing…' : 'Undo'}
            </Button>
            {undoError && (
              <div
                className="mt-1 text-[11px] text-destructive"
                data-testid="merge-toast-undo-error"
              >
                {undoError}
              </div>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="Close"
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={handleClose}
        data-testid="merge-toast-close"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
