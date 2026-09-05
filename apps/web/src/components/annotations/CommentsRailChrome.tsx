/**
 * The comments rail's chrome — the toggle button and the `<aside>` that
 * hosts `CommentsPanel` — shared by the browser and daemon document pages
 * (previously duplicated verbatim). Both are pure projections of
 * `useCommentsRail`'s output plus one keeper answer: whether the surface
 * behind the rail is WRITABLE right now.
 */

import type { CommentThread } from '@kamiazya/whiteboard-model'
import { ChevronDown, ChevronUp, MessageSquare, X } from 'lucide-react'
import { type JSX, useState } from 'react'
import { Button } from '../../components/ui/button.js'
import type { CommentsRail } from '../../hooks/use-comments-rail.js'
import { cn } from '../../lib/utils.js'
import { TOGGLE_STATE_CLASS } from '../ui/dock-button.js'
import { CommentsPanel } from './CommentsPanel.js'

export function CommentsRailToggle({ rail }: { readonly rail: CommentsRail }): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={
        rail.openThreadCount === 0 ? 'Comments' : `Comments, ${rail.openThreadCount} open`
      }
      aria-pressed={rail.open}
      onClick={rail.toggle}
      // A toggle has to LOOK toggled: without this the rail's open state was
      // announced to a screen reader and invisible to everyone else.
      className={TOGGLE_STATE_CLASS}
    >
      <MessageSquare aria-hidden="true" className="size-4" />
      {rail.openThreadCount > 0 ? (
        <span className="ml-1 text-xs">{rail.openThreadCount}</span>
      ) : null}
    </Button>
  )
}

export function CommentsRailAside({
  rail,
  threads,
  writable,
}: {
  readonly rail: CommentsRail
  readonly threads: readonly CommentThread[]
  /**
   * Whether the surface behind the rail is the LIVE document. Not while a
   * past version (or, on the daemon page, a variation preview) is on
   * screen: the editor is replaced by DocumentPreview but this rail is not,
   * and a reply is a write to the live document — sent from a surface
   * showing something else entirely.
   */
  readonly writable: boolean
}): JSX.Element | null {
  // A column where there is width for one, a bottom sheet over the editor
  // under 768px — the same two shapes the history panel takes, because a
  // 288px column beside a 412px phone screen left the editor a strip a
  // finger could not write in. The sheet peeks at 45% and expands to the
  // full height from its grab handle.
  const [expanded, setExpanded] = useState(false)
  if (!rail.open) return null
  return (
    <aside
      aria-label="Comments"
      data-testid="comments-rail"
      data-stage={expanded ? 'full' : 'peek'}
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 flex min-h-0 flex-col border-t bg-background shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.35)]',
        expanded ? 'h-full' : 'h-[45%] rounded-t-2xl',
        'md:static md:z-auto md:h-auto md:w-72 md:max-w-[calc(100vw-1.5rem)] md:shrink-0 md:rounded-none md:border-t-0 md:border-l md:shadow-none',
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 pt-1.5 md:hidden">
        <span className="text-xs font-medium text-muted-foreground">Comments</span>
        <button
          type="button"
          data-testid="comments-stage-toggle"
          aria-label={expanded ? 'Collapse comments' : 'Expand comments'}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          // The sheet's grab handle: a wide, shallow target a thumb aims at
          // the edge for, not an icon-sized one.
          className="flex h-6 w-16 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" className="size-4" />
          ) : (
            <ChevronUp aria-hidden="true" className="size-4" />
          )}
        </button>
        <button
          type="button"
          aria-label="Close comments"
          onClick={rail.toggle}
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <CommentsPanel
          threads={threads}
          resolveAnchor={rail.resolveAnchor}
          revealThreadId={rail.selectedThreadId}
          onSelect={(thread) => rail.selectThread(thread.id)}
          onReply={writable ? rail.reply : undefined}
          composeAnchor={writable ? rail.composeAnchor : null}
          onCreateThread={writable ? rail.createThread : undefined}
          onCancelCompose={rail.cancelCompose}
          onComposeDocument={writable ? () => rail.composeThread({ kind: 'document' }) : undefined}
          onResolve={writable ? rail.resolve : undefined}
          onEditMessage={writable ? rail.editMessage : undefined}
        />
      </div>
    </aside>
  )
}
