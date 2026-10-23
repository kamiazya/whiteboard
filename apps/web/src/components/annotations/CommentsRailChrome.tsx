/**
 * The comments rail's panel, as the inspector's vessel hosts it — shared by
 * the browser and daemon document pages. A
 * pure projection of `useCommentsRail`'s output plus one keeper answer:
 * whether the surface behind the rail is WRITABLE right now.
 *
 * Its OPENER is not here: it is one member of `InspectorSegment`, with the
 * other three, so that no file owning a panel also decides where in the row
 * its button lands.
 */

import type { CommentThread } from '@kamiazya/whiteboard-model'
import { type JSX, useSyncExternalStore } from 'react'
import type { CommentsRail } from '../../hooks/use-comments-rail.js'
import type { ShowResolvedSource } from '../../lib/spatial/editor-handle.js'
import { InspectorPanel } from '../ui/InspectorPanel.js'
import { CommentsPanel } from './CommentsPanel.js'

const NO_SUBSCRIBE = (): (() => void) => () => {}

export function CommentsRailAside({
  rail,
  threads,
  writable,
  showResolved,
  onShowResolvedChange,
}: {
  readonly rail: CommentsRail
  readonly threads: readonly CommentThread[]
  /**
   * Whether the surface behind the rail is the LIVE document. Not while a
   * past version is on screen: the editor is replaced by VersionPreview but this rail is not,
   * and a reply is a write to the live document — sent from a surface
   * showing something else entirely.
   */
  readonly writable: boolean
  /** The canvas's resolved-conversations view state, when a canvas is mounted to follow. */
  readonly showResolved?: ShowResolvedSource
  readonly onShowResolvedChange?: (show: boolean) => void
}): JSX.Element | null {
  const shown = useSyncExternalStore(
    showResolved?.subscribe ?? NO_SUBSCRIBE,
    () => showResolved?.get() ?? false,
  )
  if (!rail.open) return null
  return (
    <InspectorPanel kind="comments" onClose={rail.toggle}>
      <div className="p-2">
        <CommentsPanel
          threads={threads}
          resolveAnchor={rail.resolveAnchor}
          anchorLabelOf={rail.anchorLabelOf}
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
          {...(showResolved !== undefined && onShowResolvedChange !== undefined
            ? { showResolvedOnCanvas: shown, onShowResolvedOnCanvasChange: onShowResolvedChange }
            : {})}
        />
      </div>
    </InspectorPanel>
  )
}
