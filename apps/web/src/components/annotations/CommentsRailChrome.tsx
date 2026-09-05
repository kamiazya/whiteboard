/**
 * The comments rail's chrome — the toggle button and the `<aside>` that
 * hosts `CommentsPanel` — shared by the browser and daemon document pages
 * (previously duplicated verbatim). Both are pure projections of
 * `useCommentsRail`'s output plus one keeper answer: whether the surface
 * behind the rail is WRITABLE right now.
 */

import type { CommentThread } from '@kamiazya/whiteboard-model'
import { MessageSquare } from 'lucide-react'
import type { JSX } from 'react'
import { Button } from '../../components/ui/button.js'
import type { CommentsRail } from '../../hooks/use-comments-rail.js'
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
  if (!rail.open) return null
  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l bg-background p-2">
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
      />
    </aside>
  )
}
