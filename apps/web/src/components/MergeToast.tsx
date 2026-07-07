import { apiFetch } from '@kamiazya/whiteboard-mcp/api-client'
import { CheckCircle2, Undo2, X } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import {
  MERGE_COMMITTED_EVENT,
  type MergeCommittedDetail,
  parseMergeCommittedEvent,
} from '@/lib/merge-committed-event'
import { cn } from '@/lib/utils'
import { Button } from './ui/button.js'

// Short-lived toast shown in the bottom-right after merge completes.
// - Content: ✓ merged source branch, summary counts, optional Undo
// - Auto-dismiss: 5 seconds by default; pause while hovered
// - Undo hides the toast immediately and restores preMergeVersionId
//
// MergeDialog dispatches excalidraw:merge_committed, and CanvasPage mounts this so it stays local to the canvas view.

export interface MergeToastProps {
  workspaceId: string
  slug: string
  // Called after a successful restore so CanvasPage can clear its local undo stack.
  onRestored?: () => void
}

interface ActiveToast {
  key: number
  detail: MergeCommittedDetail
}

export function MergeToast({ workspaceId, slug, onRestored }: MergeToastProps): JSX.Element | null {
  const [active, setActive] = useState<ActiveToast | null>(null)
  const [undoing, setUndoing] = useState(false)
  const hoverRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (event: Event) => {
      const detail = parseMergeCommittedEvent(event)
      if (!detail) return
      if (detail.workspaceId !== workspaceId || detail.slug !== slug) return
      setActive({ key: Date.now(), detail })
    }
    window.addEventListener(MERGE_COMMITTED_EVENT, handler)
    return () => window.removeEventListener(MERGE_COMMITTED_EVENT, handler)
  }, [workspaceId, slug])

  useEffect(() => {
    if (!active) return
    // Auto-close after 5 seconds. Do not reschedule while hovered; mouseleave starts the next timer.
    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        if (!hoverRef.current) setActive(null)
      }, 5000)
    }
    schedule()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [active])

  if (!active) return null

  const {
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
    try {
      const res = await apiFetch(
        `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/versions/${preMergeVersionId}/restore`,
        { method: 'POST' },
      )
      if (res.ok) {
        onRestored?.()
      }
    } catch {
      /* If restore fails, close the toast and leave further reporting to websocket-driven state. */
    } finally {
      setUndoing(false)
      setActive(null)
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
      }}
      className={cn(
        'pointer-events-auto fixed bottom-4 right-4 z-50 flex w-[380px] max-w-[90vw] items-start gap-3',
        'rounded-lg border-2 bg-background p-3 shadow-lg',
        'border-emerald-500/60 ring-1 ring-emerald-500/20',
      )}
    >
      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-sm font-medium">Merged changes from «{sourceName}»</div>
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
            {switchedHead ? `Switched to "${switchedHead.to}"` : null}
            {switchedHead && deletedSource ? ' · ' : null}
            {deletedSource ? `Deleted "${deletedSource}"` : null}
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

export default MergeToast
