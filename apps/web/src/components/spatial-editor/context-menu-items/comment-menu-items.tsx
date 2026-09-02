/**
 * The comment branch: a comment is not content, so none of the node, edge
 * or canvas verbs apply — its band is its own lifecycle. There is no
 * removal anywhere (ADR-0025 decision 2): closing the conversation is the
 * only way to put a comment away, so editing the text is the band for now.
 */
import { commentAnchor } from '@kamiazya/whiteboard-canvas-render'
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { Pencil } from 'lucide-react'
import type { MutableRefObject } from 'react'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'

export interface CommentMenuItemsInput {
  readonly comment: CanvasComment
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly setCommentCompose: CanvasCommands['setCommentCompose']
}

export function commentMenuItems({
  comment,
  canvasRef,
  setCommentCompose,
}: CommentMenuItemsInput): ContextMenuItem[] {
  return [
    {
      label: 'Edit comment',
      icon: <Pencil />,
      // Opened at the comment's own anchor — the same producer the layer
      // draws from — so the bubble opens exactly over the drawn one.
      onSelect: () =>
        setCommentCompose({
          point: commentAnchor(comment, canvasRef.current),
          editing: { id: comment.id, initialText: comment.text },
        }),
    },
  ]
}
