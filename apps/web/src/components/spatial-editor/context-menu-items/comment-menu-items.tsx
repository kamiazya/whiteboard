/**
 * The comment branch: a comment is not content, so none of the node, edge
 * or canvas verbs apply — its band is its own lifecycle, which is now just
 * resolve or reopen. There is no removal anywhere (ADR-0025 decision 2):
 * closing the conversation is the only way to put a comment away.
 */
import type { CanvasComment } from '@kamiazya/whiteboard-model'
import { CircleCheck, RotateCcw } from 'lucide-react'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'

export interface CommentMenuItemsInput {
  readonly comment: CanvasComment
  readonly applyResult: CanvasCommands['applyResult']
}

export function commentMenuItems({
  comment,
  applyResult,
}: CommentMenuItemsInput): ContextMenuItem[] {
  // Deliberately NO Reply row. Pressing the comment opens its card, whose
  // reply box is already open — a menu row would be a third gesture to the
  // act this surface exists for, and a second place for the same one.
  //
  // And no Edit row either, since 2026-09-08. It opened a pre-filled compose
  // bubble over the pin, which could only ever rewrite `messages[0]` —
  // editing there wrote the flat comment's `text`, and a reply is not in it.
  // Editing lives on the message now, in the card, where it can name WHICH
  // message. A second mechanism reaching only the first one is the design
  // this retires.
  return [
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
