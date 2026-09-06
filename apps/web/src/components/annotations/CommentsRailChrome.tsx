/**
 * The comments rail's panel, as the inspector's vessel hosts it — shared by
 * the browser and daemon document pages (previously duplicated verbatim). A
 * pure projection of `useCommentsRail`'s output plus one keeper answer:
 * whether the surface behind the rail is WRITABLE right now.
 *
 * Its OPENER is not here: it is one member of `InspectorSegment`, with the
 * other three, so that no file owning a panel also decides where in the row
 * its button lands.
 */

import type { CommentThread } from '@kamiazya/whiteboard-model'
import type { JSX } from 'react'
import type { CommentsRail } from '../../hooks/use-comments-rail.js'
import { InspectorPanel } from '../document-editor/InspectorPanel.js'
import { CommentsPanel } from './CommentsPanel.js'

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
          onReturnFocus={rail.returnFocus}
        />
      </div>
    </InspectorPanel>
  )
}
