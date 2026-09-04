/**
 * The comment branch: a comment is not content, so none of the node, edge
 * or canvas verbs apply — its band is its own lifecycle: reply, edit, and
 * resolve or reopen. There is no removal anywhere (ADR-0025 decision 2): closing
 * the conversation is the only way to put a comment away.
 */
import { commentAnchor } from '@kamiazya/whiteboard-canvas-render'
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { CircleCheck, Pencil, Reply, RotateCcw } from 'lucide-react'
import type { MutableRefObject } from 'react'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'

export interface CommentMenuItemsInput {
  readonly comment: CanvasComment
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly setCommentCompose: CanvasCommands['setCommentCompose']
  readonly replyToComment?: CanvasCommands['replyToComment']
  readonly applyResult: CanvasCommands['applyResult']
}

export function commentMenuItems({
  comment,
  canvasRef,
  setCommentCompose,
  replyToComment,
  applyResult,
}: CommentMenuItemsInput): ContextMenuItem[] {
  return [
    // Only where the host can show the answer afterwards: the canvas draws a
    // conversation's opening message alone, so on a surface with no rail a
    // reply would land correctly and look like nothing happened.
    ...(replyToComment === undefined
      ? []
      : [
          {
            label: 'Reply',
            icon: <Reply />,
            onSelect: () => replyToComment(comment),
          },
        ]),
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
