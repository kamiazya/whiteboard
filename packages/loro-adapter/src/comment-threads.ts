import {
  type CanvasComment,
  type CommentMessage,
  type CommentThread,
  type CommentThreadStatus,
  canvasCommentSchema,
  commentMessageSchema,
  commentThreadSchema,
  compareMessages,
  threadFromCanvasComment,
} from '@kamiazya/whiteboard-model'
import { LoroMap } from 'loro-crdt'
import { COMMENTS_KEY, type DocumentContainers, THREADS_KEY } from './containers.js'

/** The nested map of messages inside one thread's container. */
const MESSAGES_KEY = 'messages'
const ANCHOR_FIELD = 'anchor'
const STATUS_FIELD = 'status'
const CREATED_AT_FIELD = 'createdAt'

function threadContainer(doc: DocumentContainers, threadId: string): LoroMap | undefined {
  const stored = doc.getMap(THREADS_KEY).get(threadId)
  return stored instanceof LoroMap ? stored : undefined
}

function messageToFields(message: CommentMessage): Record<string, unknown> {
  const fields: Record<string, unknown> = { id: message.id, body: message.body }
  if (message.author !== undefined) fields.author = message.author
  if (message.createdAt !== undefined) fields.createdAt = message.createdAt
  if (message.editedAt !== undefined) fields.editedAt = message.editedAt
  return fields
}

function assertFiniteAnchor(thread: CommentThread): void {
  // Loud for the same reason `nodeToFields` is: the read below round-trips
  // every thread through its Zod schema and silently drops what fails, so a
  // non-finite anchor written here would delete the thread for every reader —
  // every synced peer, with no signal anywhere.
  if (thread.anchor.kind !== 'spatial') return
  for (const [field, value] of [
    ['x', thread.anchor.x],
    ['y', thread.anchor.y],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `comment thread "${thread.id}" has a non-finite ${field} (${value}); the anchor must be finite`,
      )
    }
  }
}

/**
 * Creates or replaces one thread's own fields and writes its messages.
 *
 * `getOrCreateContainer` and not `setContainer`: the latter REPLACES the
 * container, discarding whatever a peer put in it. Creating one is still the
 * only path allowed to open a thread container at all — measured on
 * loro-crdt 1.13.6, two replicas that create a container under the same key
 * with no common ancestor merge to ONE of them and the other side's entries
 * are gone. Creation mints its own id and cannot collide; every other write
 * below therefore refuses to open a container it did not find.
 */
export function writeCommentThread(doc: DocumentContainers, thread: CommentThread): void {
  writeThreadInto(doc, thread)
  doc.commit()
}

/**
 * The same write without the commit, for a caller that owns the commit
 * boundary — `withSpatialBatch`, where an extra commit would split one user
 * action into two undo steps, and the migration below, which is always run
 * from a seam that commits after it.
 */
export function writeThreadInto(doc: DocumentContainers, thread: CommentThread): void {
  assertFiniteAnchor(thread)
  const container = doc.getMap(THREADS_KEY).getOrCreateContainer(thread.id, new LoroMap())
  container.set(ANCHOR_FIELD, thread.anchor)
  container.set(STATUS_FIELD, thread.status)
  if (thread.createdAt !== undefined) container.set(CREATED_AT_FIELD, thread.createdAt)
  const messages = container.getOrCreateContainer(MESSAGES_KEY, new LoroMap())
  for (const message of thread.messages) messages.set(message.id, messageToFields(message))
}

/**
 * Writes exactly one message, leaving every other message and the thread's own
 * fields untouched — the append path AND the edit path, since an edit is the
 * same message id written again.
 *
 * A no-op for a thread this replica does not hold: see `writeCommentThread`
 * for why replying must never be the write that opens a container.
 */
export function writeThreadMessage(
  doc: DocumentContainers,
  threadId: string,
  message: CommentMessage,
): void {
  const container = threadContainer(doc, threadId)
  if (container === undefined) return
  container
    .getOrCreateContainer(MESSAGES_KEY, new LoroMap())
    .set(message.id, messageToFields(message))
  doc.commit()
}

/**
 * Closes or reopens a thread. One key, last-writer-wins, which is all a
 * status needs: two peers resolving concurrently agree, and neither touches
 * the messages beneath.
 */
export function setCommentThreadStatus(
  doc: DocumentContainers,
  threadId: string,
  status: CommentThreadStatus,
): void {
  const container = threadContainer(doc, threadId)
  if (container === undefined) return
  container.set(STATUS_FIELD, status)
  doc.commit()
}

/**
 * Every thread the document holds, ordered by id and with each thread's
 * messages in `compareMessages` order, so two replicas that merged the same
 * writes render the same conversation.
 *
 * A record the schema rejects costs that record and nothing beside it — the
 * same contract `readSpatialCanvas` already keeps for nodes and comments.
 */
export function readCommentThreads(doc: DocumentContainers): CommentThread[] {
  const threadsMap = doc.getMap(THREADS_KEY)
  const threads: CommentThread[] = []
  for (const threadId of threadsMap.keys()) {
    const container = threadContainer(doc, threadId)
    if (container === undefined) continue
    const messagesContainer = container.get(MESSAGES_KEY)
    const messages: CommentMessage[] = []
    if (messagesContainer instanceof LoroMap) {
      for (const messageId of messagesContainer.keys()) {
        const parsed = commentMessageSchema.safeParse(messagesContainer.get(messageId))
        if (parsed.success) messages.push(parsed.data)
      }
    }
    const createdAt = container.get(CREATED_AT_FIELD)
    const parsed = commentThreadSchema.safeParse({
      id: threadId,
      anchor: container.get(ANCHOR_FIELD),
      status: container.get(STATUS_FIELD),
      ...(createdAt === undefined ? {} : { createdAt }),
      messages: messages.sort(compareMessages),
    })
    if (parsed.success) threads.push(parsed.data)
  }
  return threads.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Reads every stored canvas comment as the one-message thread it always was,
 * clears the legacy `comments` map, and returns how many it converted.
 *
 * Idempotent, and destructive on purpose now that every writer puts comments
 * in the threads plane: a legacy row left behind would outlive the thread it
 * became, and come back through `readSpatialCanvas`'s fallback as a comment
 * the user had closed. An id that ALREADY has a thread is dropped rather than
 * rewritten — a second pass must not clobber a reply written since the first.
 *
 * A row the schema rejects is dropped too. It was already unreadable (every
 * reader parses before projecting), so keeping it would preserve nothing but
 * the fallback's reason to exist.
 *
 * Does NOT commit: every caller is a write seam that commits after it, and
 * one of them is `withSpatialBatch`, where an extra commit would split a user
 * action into two undo steps.
 */
export function migrateCanvasCommentsToThreads(doc: DocumentContainers): number {
  const commentsMap = doc.getMap(COMMENTS_KEY)
  const existing = new Set(doc.getMap(THREADS_KEY).keys())
  let migrated = 0
  for (const commentId of commentsMap.keys()) {
    const parsed = canvasCommentSchema.safeParse(commentsMap.get(commentId))
    if (parsed.success && !existing.has(commentId)) {
      writeThreadInto(doc, threadFromCanvasComment(parsed.data satisfies CanvasComment))
      migrated += 1
    }
    commentsMap.delete(commentId)
  }
  return migrated
}
