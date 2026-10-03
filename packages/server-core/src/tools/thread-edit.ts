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
  annotationAnchorSchema,
  annotationIdSchema,
  commentThreadSchema,
  documentIdSchema,
  nodeText,
  okfActorSchema,
  resolveTextAnchor,
  type SpatialAnchor,
  type TextAnchor,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import { loadDocument, saveDocumentSnapshot } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
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

const bodySchema = z.string().min(1, 'a comment message must not be empty')

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
      threadId: annotationIdSchema.optional(),
      anchor: annotationAnchorSchema,
      body: bodySchema,
      author: okfActorSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('message.add'),
      threadId: annotationIdSchema,
      body: bodySchema,
      author: okfActorSchema.optional(),
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
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    ops: z.array(threadOpSchema).min(1, 'give at least one op'),
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
 * Why an anchor names nothing on this document, or `undefined` when it names
 * something. Checked at write time because an orphaned thread (ADR-0026
 * decision 4) is what a LATER deletion leaves behind: opening one already
 * orphaned is a typo the caller reads back as success.
 */
function anchorRefusal(anchor: AnnotationAnchor, content: DocumentContent): string | undefined {
  if (anchor.kind === 'document') return undefined
  return anchor.kind === 'spatial'
    ? spatialAnchorRefusal(anchor, content)
    : textAnchorRefusal(anchor, content)
}

function spatialAnchorRefusal(anchor: SpatialAnchor, content: DocumentContent): string | undefined {
  if (content.kind === 'markdown') {
    return 'a markdown document has no canvas to anchor to; anchor to a quoted passage (kind: text) or to the document as a whole (kind: document)'
  }
  const { nodes, edges } = content.canvas
  const missingNode = [anchor.nodeId, ...(anchor.nodeIds ?? [])].find(
    (id) => id !== undefined && !nodes.some((node) => node.id === id),
  )
  if (missingNode !== undefined) return `node "${missingNode}" is not on the canvas`
  if (anchor.edgeId !== undefined && !edges.some((edge) => edge.id === anchor.edgeId)) {
    return `edge "${anchor.edgeId}" is not on the canvas`
  }
  return undefined
}

/** The text a passage is quoted from, or why there is none. */
function quotedText(
  nodeId: string | undefined,
  content: DocumentContent,
): { readonly text: string } | { readonly refusal: string } {
  if (nodeId === undefined) {
    return content.kind === 'markdown'
      ? { text: content.body }
      : { refusal: 'a canvas has no body to quote; name the text node the passage is in (nodeId)' }
  }
  if (content.kind === 'markdown') {
    return { refusal: `a markdown document has no node "${nodeId}"; omit nodeId to quote its body` }
  }
  const node = content.canvas.nodes.find((candidate) => candidate.id === nodeId)
  if (node === undefined) return { refusal: `node "${nodeId}" is not on the canvas` }
  const text = nodeText(node)
  return text === undefined ? { refusal: `node "${nodeId}" is not a text node` } : { text }
}

function textAnchorRefusal(anchor: TextAnchor, content: DocumentContent): string | undefined {
  const quoted = quotedText(anchor.nodeId, content)
  if ('refusal' in quoted) return quoted.refusal
  if (resolveTextAnchor(quoted.text, anchor).kind === 'placed') return undefined
  const where = anchor.nodeId === undefined ? 'body' : `text of node "${anchor.nodeId}"`
  return `the passage ${JSON.stringify(anchor.quote.exact)} is not in the ${where}`
}

/** What one op of a `wb_thread_edit` batch is applied against. */
interface ThreadEditContext {
  readonly doc: LoroDoc
  /** What the document held before the batch; no op here changes it. */
  readonly content: DocumentContent
  /** The thread ids this document holds, grown as the batch opens more. */
  readonly held: Set<string>
  /** One timestamp for the whole batch, so a batch reads as one act. */
  readonly now: string
  readonly index: number
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
    const refusal = anchorRefusal(op.anchor, ctx.content)
    if (refusal !== undefined) throw new ThreadEditError(index, op.op, refusal)
    writeCommentThread(doc, {
      id,
      anchor: op.anchor,
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
  },

  'message.add': (ctx, op) => {
    const { doc, held, now, index } = ctx
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
    const existing = readAnnotations(doc).find((thread) => thread.id === op.threadId)
    const taken = new Set(existing?.messages.map((message) => message.id) ?? [])
    let suffix = taken.size + 1
    while (taken.has(`${op.threadId}-m${suffix}`)) suffix += 1
    writeThreadMessage(doc, op.threadId, {
      id: `${op.threadId}-m${suffix}`,
      body: op.body,
      createdAt: now,
      ...(op.author === undefined ? {} : { author: op.author }),
    })
  },

  'thread.resolve': (ctx, op) => {
    const { doc, held, index } = ctx
    if (!held.has(op.threadId)) {
      throw new ThreadEditError(index, op.op, `thread "${op.threadId}" is not on this document`)
    }
    setCommentThreadStatus(doc, op.threadId, op.resolved === false ? 'open' : 'resolved')
  },
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
  // and `anchorRefusal` holds each arm to the surface it points at.
  const indexed = await deps.documentIndex.resolveDocumentById({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
  })
  const content = readDocumentContent(doc, indexed?.kind)
  const held = new Set(readAnnotations(doc).map((thread) => thread.id))
  const now = new Date().toISOString()
  for (const [index, op] of input.ops.entries()) {
    applyThreadOp({ doc, content, held, now, index }, op)
  }

  await saveDocumentSnapshot(deps, input.workspaceId, input.documentId, doc)

  return { threads: readAnnotations(doc) }
}
