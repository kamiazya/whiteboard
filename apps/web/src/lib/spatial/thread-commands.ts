/**
 * What an editor command does to the document's conversations — the half of
 * a thread command `applyCommand` deliberately leaves alone, since the
 * annotation layer is a plane beside the canvas (ADR-0026 decision 1).
 *
 * The sync session publishes this at once, the way it publishes the next
 * canvas at once, so a pin is drawn, moved or muted before the debounced
 * commit lands; the commit's own read then answers the same list and
 * publishes nothing more. It therefore keeps the stored order — threads by
 * id, messages by `compareMessages` — or the republish would reorder the
 * pins, and with them which bubble yields to which.
 *
 * Total like `applyCommand`: a command naming no thread it can act on, or no
 * thread at all, answers the same array reference.
 */
import {
  type CommentMessage,
  type CommentThread,
  compareCodeUnit,
  compareMessages,
  movedAnchor,
} from '@kamiazya/whiteboard-model'
import type { EditorCommand } from './commands.js'

function withThread(
  threads: readonly CommentThread[],
  threadId: string,
  update: (thread: CommentThread) => CommentThread,
): readonly CommentThread[] {
  const index = threads.findIndex((thread) => thread.id === threadId)
  const held = threads[index]
  if (held === undefined) return threads
  const next = update(held)
  if (next === held) return threads
  return threads.map((thread, i) => (i === index ? next : thread))
}

function withMessage(thread: CommentThread, message: CommentMessage): CommentThread {
  const others = thread.messages.filter((held) => held.id !== message.id)
  return { ...thread, messages: [...others, message].sort(compareMessages) }
}

export function threadsAfterCommand(
  threads: readonly CommentThread[],
  command: EditorCommand,
): readonly CommentThread[] {
  switch (command.kind) {
    case 'create-thread': {
      const { thread } = command
      if (threads.some((held) => held.id === thread.id)) return threads
      const opened = { ...thread, messages: [...thread.messages].sort(compareMessages) }
      return [...threads, opened].sort((a, b) => compareCodeUnit(a.id, b.id))
    }
    case 'reply-to-thread':
    case 'edit-thread-message':
      return withThread(threads, command.threadId, (thread) => withMessage(thread, command.message))
    case 'set-thread-status':
      return withThread(threads, command.threadId, (thread) =>
        thread.status === command.status ? thread : { ...thread, status: command.status },
      )
    case 'move-thread':
      return withThread(threads, command.threadId, (thread) => {
        const anchor = movedAnchor(thread.anchor, command)
        return anchor === thread.anchor ? thread : { ...thread, anchor }
      })
    case 'batch':
      return command.commands.reduce(threadsAfterCommand, threads)
    default:
      return threads
  }
}
