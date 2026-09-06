/**
 * The rail's four writes, aimed at a SPATIAL document.
 *
 * One place rather than one per page, because the two pages that had it by
 * hand made the same mistake in both: they handed `onChange` the canvas they
 * were holding instead of the canvas the command produces. Storage was
 * right and the picture was not — a status resolved from the rail left the
 * bubble drawn until a reload, and reopening never brought it back.
 *
 * The reducer is the only thing that knows a thread's status projects onto
 * a flat comment's `resolved`, that a new thread projects a pin, and that
 * an opening message is that comment's text. So every command goes through
 * it here, and a fifth member of `CommentsRailWrite` is added once, in a
 * file whose whole subject is getting this right.
 *
 * `canvasNow` is a getter, not a value: a rail press happens long after the
 * door is built, and a captured canvas would write an edit onto a stale one.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { applyCommand, type EditorCommand } from '../lib/spatial/commands.js'
import type { CommentsRailWrite } from './use-comments-rail.js'

export function spatialThreadWrite(
  canvasNow: () => SpatialCanvas,
  onChange: (next: SpatialCanvas, command: EditorCommand) => void,
): CommentsRailWrite {
  const send = (command: EditorCommand): void => {
    onChange(applyCommand(canvasNow(), command), command)
  }
  return {
    createThread: (thread) => send({ kind: 'create-thread', thread }),
    replyToThread: (threadId, message) => send({ kind: 'reply-to-thread', threadId, message }),
    setThreadStatus: (threadId, status) => send({ kind: 'set-thread-status', threadId, status }),
    editMessage: (threadId, message, opening) =>
      send({ kind: 'edit-thread-message', threadId, message, opening }),
  }
}
