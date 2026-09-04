/**
 * The comment branch: a comment is not content, so none of the node, edge
 * or canvas verbs apply — its band is its own lifecycle: edit, and resolve
 * or reopen. There is no removal anywhere (ADR-0025 decision 2): closing
 * the conversation is the only way to put a comment away.
 */
import { commentAnchor } from '@kamiazya/whiteboard-canvas-render'
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { CircleCheck, Pencil, RotateCcw } from 'lucide-react'
import type { MutableRefObject } from 'react'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'

export interface CommentMenuItemsInput {
  readonly comment: CanvasComment
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly setCommentCompose: CanvasCommands['setCommentCompose']
  readonly applyResult: CanvasCommands['applyResult']
}

export function commentMenuItems({
  comment,
  canvasRef,
  setCommentCompose,
  applyResult,
}: CommentMenuItemsInput): ContextMenuItem[] {
  // Deliberately NO Reply row. Pressing the comment opens its card, whose
  // reply box is already open — a menu row would be a third gesture to the
  // act this surface exists for, and a second place for the same one.
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
    comment.resolved === true
      ? {
          label: 'Reopen',
          icon: <RotateCcw />,
          onSelect: () =>
            applyResult({
              state: { kind: 'idle' },
              commands: [
                { kind: 'set-comment-resolved', id: comment.id, resolved: false } as const,
              ],
            }),
        }
      : {
          label: 'Resolve',
          icon: <CircleCheck />,
          onSelect: () =>
            applyResult({
              state: { kind: 'idle' },
              commands: [{ kind: 'set-comment-resolved', id: comment.id, resolved: true } as const],
            }),
        },
  ]
}
