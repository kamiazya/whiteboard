import {
  type DocumentContent,
  readAnnotations,
  readDocumentContent,
  setCommentThreadStatus,
  writeCommentThread,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  type AnnotationAnchor,
  annotationAnchorInputSchema,
  annotationIdInputSchema,
  annotationIdSchema,
  type CommentThread,
  type CommentThreadStatus,
  commentMessageInputSchema,
  commentThreadSchema,
  documentIdSchema,
  nodeText,
  OPS_PER_CALL_LIMIT_PHRASE,
  OPS_PER_CALL_MAX,
  okfActorInputSchema,
  placeTextAnchor,
  type SpatialAnchor,
  type SpatialCanvas,
  type TextAnchor,
} from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import { loadDocument, saveDocumentSnapshot } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import {
  announceAgentActivity,
  COMMENT_SUMMARY_WORDS,
  resolveSummaryWord,
} from './agent-activity.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { openThreadsRefusal } from './open-annotation-ceilings.js'
import { workspaceAddressArgSchema } from './workspace-address-arg.js'
import { withWorkspaceWrite } from './write-lock.js'

/**
 * "Nothing was written" is literal here, not a formula copied from
 * `wb_canvas_edit`: every op mutates the in-memory `LoroDoc` and the snapshot
 * is saved once, after the last op. A throw leaves the stored document
 * exactly as it was.
 */
class ThreadEditError extends Error {
  constructor(
    readonly opIndex: number,
    readonly op: string,
    detail: string,
  ) {
    super(`ops[${opIndex}] (${op}) could not be applied: ${detail}. Nothing was written.`)
    this.name = 'ThreadEditError'
  }
}

/**
 * The three ops, and deliberately only these three.
 *
 * There is no `thread.remove` and no `message.remove`, for the reason
 * ADR-0025 decision 2 gave and ADR-0026 decision 6 carries into a second
 * format: a verb one side has and the other does not lets an agent erase
 * feedback a person can only close. `thread.resolve` is the whole close, and
 * it reopens.
 */
const threadOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('thread.add'),
      /** Minted when absent, so a caller never has to invent an id. */
      threadId: annotationIdInputSchema.optional(),
      anchor: annotationAnchorInputSchema,
      body: commentMessageInputSchema,
      author: okfActorInputSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('message.add'),
      threadId: annotationIdSchema,
      body: commentMessageInputSchema,
      author: okfActorInputSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('thread.resolve'),
      threadId: annotationIdSchema,
      /** `false` reopens. */
      resolved: z.boolean().optional(),
    })
    .strict(),
])

const threadEditInputSchema = z
  .object({
    workspaceId: workspaceAddressArgSchema,
    documentId: documentIdSchema,
    ops: z
      .array(threadOpSchema)
      .min(1, 'give at least one op')
      .max(OPS_PER_CALL_MAX, `more ops than ${OPS_PER_CALL_LIMIT_PHRASE}`),
  })
  .strict()
type ThreadEditInput = z.infer<typeof threadEditInputSchema>

const threadEditOutputSchema = z
  .object({
    /**
     * Every thread the document now holds, whole — anchor, status, and each
     * message with its author and time — so a caller that opened one has its
     * minted id without a second read, and a caller that replied can read the
     * conversation it joined rather than a count of it.
     */
    threads: z.array(commentThreadSchema),
  })
  .strict()
type ThreadEditOutput = z.infer<typeof threadEditOutputSchema>

function mintThreadId(taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = `t${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * A board's ids, indexed once per batch: an anchor may name a board's worth of
 * nodes and a batch may hold many anchors, so looking each id up by walking the
 * board is ops x ids x nodes of work under the workspace write lock.
 */
interface BoardIndex {
  readonly nodes: ReadonlyMap<string, SpatialCanvas['nodes'][number]>
  readonly edgeIds: ReadonlySet<string>
}

function boardIndexOf(content: DocumentContent): BoardIndex | undefined {
  if (content.kind === 'markdown') return undefined
  const { nodes, edges } = content.canvas
  return {
    nodes: new Map(nodes.map((node) => [node.id, node])),
    edgeIds: new Set(edges.map((edge) => edge.id)),
  }
}

/**
 * The anchor as it is stored, or why it names nothing on this document.
 * Checked at write time because an orphaned thread (ADR-0026 decision 4) is
 * what a LATER deletion leaves behind: opening one already orphaned is a typo
 * the caller reads back as success.
 *
 * A text anchor is stored at where its quote is (`placeTextAnchor`), from the
 * one resolution that also decides whether it names anything.
 */
function storedAnchor(
  anchor: AnnotationAnchor,
  content: DocumentContent,
  board: BoardIndex | undefined,
): { readonly anchor: AnnotationAnchor } | { readonly refusal: string } {
  if (anchor.kind === 'document') return { anchor }
  if (anchor.kind === 'spatial') {
    const refusal = spatialAnchorRefusal(anchor, board)
    return refusal === undefined ? { anchor } : { refusal }
  }
  return storedTextAnchor(anchor, content, board)
}

function spatialAnchorRefusal(
  anchor: SpatialAnchor,
  board: BoardIndex | undefined,
): string | undefined {
  if (board === undefined) {
    return 'a markdown document has no canvas to anchor to; anchor to a quoted passage (kind: text) or to the document as a whole (kind: document)'
  }
  const missingNode = [anchor.nodeId, ...(anchor.nodeIds ?? [])].find(
    (id) => id !== undefined && !board.nodes.has(id),
  )
  if (missingNode !== undefined) return `node "${missingNode}" is not on the canvas`
  if (anchor.edgeId !== undefined && !board.edgeIds.has(anchor.edgeId)) {
    return `edge "${anchor.edgeId}" is not on the canvas`
  }
  return undefined
}

/** The text a passage is quoted from, or why there is none. */
function quotedText(
  nodeId: string | undefined,
  content: DocumentContent,
  board: BoardIndex | undefined,
): { readonly text: string } | { readonly refusal: string } {
  if (nodeId === undefined) {
    return content.kind === 'markdown'
      ? { text: content.body }
      : { refusal: 'a canvas has no body to quote; name the text node the passage is in (nodeId)' }
  }
  if (board === undefined) {
    return { refusal: `a markdown document has no node "${nodeId}"; omit nodeId to quote its body` }
  }
  const node = board.nodes.get(nodeId)
  if (node === undefined) return { refusal: `node "${nodeId}" is not on the canvas` }
  const text = nodeText(node)
  return text === undefined ? { refusal: `node "${nodeId}" is not a text node` } : { text }
}

function storedTextAnchor(
  anchor: TextAnchor,
  content: DocumentContent,
  board: BoardIndex | undefined,
): { readonly anchor: TextAnchor } | { readonly refusal: string } {
  const quoted = quotedText(anchor.nodeId, content, board)
  if ('refusal' in quoted) return quoted
  const placed = placeTextAnchor(quoted.text, anchor)
  if (placed !== undefined) return { anchor: placed }
  const where = anchor.nodeId === undefined ? 'body' : `text of node "${anchor.nodeId}"`
  return { refusal: `the passage ${JSON.stringify(anchor.quote.exact)} is not in the ${where}` }
}

/** Why a message body says nothing, or `undefined` when it says something. */
function blankRefusal(body: string): string | undefined {
  return body.trim() === '' ? 'the message body is blank; write what the comment says' : undefined
}

/** What one op of a `wb_thread_edit` batch is applied against. */
interface ThreadEditContext {
  readonly doc: LoroDoc
  /** What the document held before the batch; no op here changes it. */
  readonly content: DocumentContent
  /** `content`'s board ids, or `undefined` for a markdown document. */
  readonly board: BoardIndex | undefined
  /** The thread ids this document holds, grown as the batch opens more. */
  readonly held: Set<string>
  /**
   * Each held thread's status and message ids, read once at load and kept
   * current by the ops, so no op re-reads the whole layer — every message of
   * every thread, resolved ones included, neither of which is bounded.
   */
  readonly tally: ThreadTally
  /** The threads the batch opened, replied to, resolved or reopened. */
  readonly touched: Set<string>
  /** One timestamp for the whole batch, so a batch reads as one act. */
  readonly now: string
  readonly index: number
}

/** What the ceiling and the reply ids are judged from, as the batch leaves it. */
interface ThreadTally {
  readonly status: Map<string, CommentThreadStatus>
  readonly messageIds: Map<string, Set<string>>
  open: number
}

function tallyOf(threads: readonly CommentThread[]): ThreadTally {
  return {
    status: new Map(threads.map((thread) => [thread.id, thread.status])),
    messageIds: new Map(
      threads.map((thread) => [thread.id, new Set(thread.messages.map((message) => message.id))]),
    ),
    open: threads.filter((thread) => thread.status === 'open').length,
  }
}

function setTalliedStatus(tally: ThreadTally, threadId: string, next: CommentThreadStatus): void {
  if (tally.status.get(threadId) === 'open') tally.open -= 1
  if (next === 'open') tally.open += 1
  tally.status.set(threadId, next)
}

type ThreadOp = ThreadEditInput['ops'][number]
type OpNamed<K extends ThreadOp['op']> = Extract<ThreadOp, { op: K }>

/**
 * One handler per op, keyed by the op's own discriminator.
 *
 * A TABLE rather than a `switch`, and the reason is measured rather than
 * stylistic: the switch carried no `default` and no exhaustiveness
 * assertion, so adding a fourth member to `threadOpSchema` produced ZERO
 * type errors — the tool would have accepted the new op and silently done
 * nothing with it. A silent no-op is worse than a wrong action, because
 * nothing downstream can tell it from success. The mapped type owes a
 * handler per member; verified by adding a fourth op and counting errors.
 *
 * Same shape as `canvas-edit-handlers.ts` and `workspace-edit.ts`, which
 * are the other two op-batch tools.
 */
const THREAD_EDIT_HANDLERS: {
  [K in ThreadOp['op']]: (ctx: ThreadEditContext, op: OpNamed<K>) => void
} = {
  'thread.add': (ctx, op) => {
    const { doc, held, now, index } = ctx
    const id = op.threadId ?? mintThreadId(held)
    if (held.has(id)) {
      throw new ThreadEditError(index, op.op, `thread "${id}" is already on this document`)
    }
    const blank = blankRefusal(op.body)
    if (blank !== undefined) throw new ThreadEditError(index, op.op, blank)
    const stored = storedAnchor(op.anchor, ctx.content, ctx.board)
    if ('refusal' in stored) throw new ThreadEditError(index, op.op, stored.refusal)
    writeCommentThread(doc, {
      id,
      anchor: stored.anchor,
      status: 'open',
      createdAt: now,
      messages: [
        {
          id: `${id}-m1`,
          body: op.body,
          createdAt: now,
          ...(op.author === undefined ? {} : { author: op.author }),
        },
      ],
    })
    held.add(id)
    setTalliedStatus(ctx.tally, id, 'open')
    ctx.tally.messageIds.set(id, new Set([`${id}-m1`]))
    ctx.touched.add(id)
  },

  'message.add': (ctx, op) => {
    const { doc, held, now, index } = ctx
    const blank = blankRefusal(op.body)
    if (blank !== undefined) throw new ThreadEditError(index, op.op, blank)
    // Refused rather than silently accepted: `writeThreadMessage` is a
    // no-op for a thread this replica does not hold, because opening a
    // container is the one write that cannot merge — two replicas that
    // create one under the same key with no common ancestor keep only
    // one side. A quiet no-op would report success over a lost reply.
    if (!held.has(op.threadId)) {
      throw new ThreadEditError(index, op.op, `thread "${op.threadId}" is not on this document`)
    }
    // Minted against the ids the thread actually HOLDS, not against
    // its message count: a peer's reply that merged in leaves the
    // count and the highest suffix disagreeing, and reusing an id is
    // an overwrite of someone else's message rather than a reply.
    const taken = ctx.tally.messageIds.get(op.threadId) ?? new Set<string>()
    let suffix = taken.size + 1
    while (taken.has(`${op.threadId}-m${suffix}`)) suffix += 1
    const id = `${op.threadId}-m${suffix}`
    ctx.tally.messageIds.set(op.threadId, new Set([...taken, id]))
    writeThreadMessage(doc, op.threadId, {
      id,
      body: op.body,
      createdAt: now,
      ...(op.author === undefined ? {} : { author: op.author }),
    })
    ctx.touched.add(op.threadId)
  },

  'thread.resolve': (ctx, op) => {
    const { doc, held, index } = ctx
    if (!held.has(op.threadId)) {
      throw new ThreadEditError(index, op.op, `thread "${op.threadId}" is not on this document`)
    }
    const next = op.resolved === false ? 'open' : 'resolved'
    if (setCommentThreadStatus(doc, op.threadId, next))
      setTalliedStatus(ctx.tally, op.threadId, next)
    ctx.touched.add(op.threadId)
  },
}

/**
 * The word a watching person reads for each op, from the vocabulary
 * `wb_canvas_edit`'s summary shares. Keyed by the op union, so a fourth op
 * owes a word; a resolve's word depends on its own `resolved`.
 */
const THREAD_OP_WORD = {
  'thread.add': () => 'commented',
  'message.add': () => 'replied',
  'thread.resolve': (op) => resolveSummaryWord(op.resolved),
} as const satisfies {
  [K in ThreadOp['op']]: (
    op: Extract<ThreadOp, { op: K }>,
  ) => (typeof COMMENT_SUMMARY_WORDS)[number]
}

function summarizeThreadOps(ops: readonly ThreadOp[]): string {
  const counts = new Map<string, number>()
  for (const op of ops) {
    const word = (THREAD_OP_WORD[op.op] as (op: ThreadOp) => string)(op)
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return COMMENT_SUMMARY_WORDS.filter((word) => counts.has(word))
    .map((word) => `${word} ${counts.get(word)}`)
    .join(', ')
}

function applyThreadOp(ctx: ThreadEditContext, op: ThreadOp): void {
  const handle = THREAD_EDIT_HANDLERS[op.op] as (ctx: ThreadEditContext, op: ThreadOp) => void
  handle(ctx, op)
}

export function createThreadEditTool(deps: ServerDeps) {
  return {
    name: 'wb_thread_edit' as const,
    description:
      "Comment on any document — a spatial canvas or a markdown note — through its annotation layer: open a thread anchored to a node, an edge, a point, a set of nodes (a spatial anchor with nodeIds and the rect they occupy), a region (a spatial anchor with width and height), a quoted passage of a note's body, a quoted passage of a text node's text (a text anchor naming the node), or the document as a whole (kind: document); reply to one; resolve or reopen one. Threads are never deleted, by an agent or by a person: resolving is the only way to close one. Returns every thread the document holds, whole (anchor, status, every message with author and time), so a newly opened thread's id needs no second read. To read threads without writing, use wb_document_get.",
    inputSchema: threadEditInputSchema,
    outputSchema: threadEditOutputSchema,
    execute(input: ThreadEditInput): Promise<ThreadEditOutput> {
      return withWorkspaceWrite(deps, input.workspaceId, () => editThreads(deps, input))
    },
  }
}

async function editThreads(deps: ServerDeps, input: ThreadEditInput): Promise<ThreadEditOutput> {
  await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
  const { doc } = await loadDocument(deps, input.workspaceId, input.documentId)

  // The layer is the same plane on every format (ADR-0026 decision 6), so no
  // op is refused for the document's KIND as such; what varies is the anchor,
  // and `storedAnchor` holds each arm to the surface it points at.
  const indexed = await deps.documentIndex.resolveDocumentById({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
  })
  const content = readDocumentContent(doc, indexed?.kind)
  const board = boardIndexOf(content)
  const atLoad = readAnnotations(doc)
  const held = new Set(atLoad.map((thread) => thread.id))
  const tally = tallyOf(atLoad)
  const openAtLoad = tally.open
  const now = new Date().toISOString()
  const touched = new Set<string>()
  for (const [index, op] of input.ops.entries()) {
    applyThreadOp({ doc, content, board, held, tally, touched, now, index }, op)
    // A reply opens nothing, so only the two ops that can are counted.
    if (op.op === 'message.add') continue
    const refusal = openThreadsRefusal(openAtLoad, tally.open)
    if (refusal !== undefined) throw new ThreadEditError(index, op.op, refusal)
  }

  await saveDocumentSnapshot(deps, input.workspaceId, input.documentId, doc)
  // Only a board has a presence surface to show it on; a note has no chip.
  if (content.kind === 'spatial') {
    const { workspaceId, documentId } = input
    const comments = [...touched].sort()
    announceAgentActivity(
      deps,
      { workspaceId, documentId, comments },
      summarizeThreadOps(input.ops),
    )
  }

  return { threads: readAnnotations(doc) }
}
