/**
 * The comments rail's chrome — the toggle button and the panel the
 * inspector's vessel hosts `CommentsPanel` in — shared by the browser and
 * daemon document pages (previously duplicated verbatim). Both are pure
 * projections of `useCommentsRail`'s output plus one keeper answer: whether
 * the surface behind the rail is WRITABLE right now.
 */

import type { CommentThread } from '@kamiazya/whiteboard-model'
import { MessageSquare } from 'lucide-react'
import type { JSX } from 'react'
import type { CommentsRail } from '../../hooks/use-comments-rail.js'
import { InspectorPanel } from '../document-editor/InspectorPanel.js'
import { HEADER_WIDE_TOGGLE_CLASS } from '../ui/header-button.js'
import { CommentsPanel } from './CommentsPanel.js'

export function CommentsRailToggle({ rail }: { readonly rail: CommentsRail }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={
        rail.openThreadCount === 0 ? 'Comments' : `Comments, ${rail.openThreadCount} open`
      }
      aria-pressed={rail.open}
      onClick={rail.toggle}
      // A toggle has to LOOK toggled: without this the rail's open state was
      // announced to a screen reader and invisible to everyone else.
      className={HEADER_WIDE_TOGGLE_CLASS}
    >
      <MessageSquare aria-hidden="true" className="size-4" />
      {rail.openThreadCount > 0 ? (
        <span className="text-xs tabular-nums">{rail.openThreadCount}</span>
      ) : null}
    </button>
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
    <InspectorPanel kind="comments" onClose={rail.toggle}>
      <div className="p-2">
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
    </InspectorPanel>
  )
}
