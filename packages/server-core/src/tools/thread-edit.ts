import {
  readAnnotations,
  setCommentThreadStatus,
  writeCommentThread,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  annotationAnchorSchema,
  annotationIdSchema,
  documentIdSchema,
  okfActorSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { loadDocument, saveDocumentSnapshot } from './document-io.js'

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
     * Every thread the document now holds, so a caller that opened one has
     * its minted id without a second read, and a caller that replied can see
     * the conversation it joined.
     */
    threads: z.array(
      z
        .object({
          id: annotationIdSchema,
          status: z.enum(['open', 'resolved']),
          messageCount: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict()
type ThreadEditOutput = z.infer<typeof threadEditOutputSchema>

function mintThreadId(taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = `t${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** What one op of a `wb_thread_edit` batch is applied against. */
interface ThreadEditContext {
  readonly doc: LoroDoc
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
      "Comment on any document — a spatial canvas or a markdown note — through its annotation layer: open a thread anchored to a node, an edge, a point, a set of nodes (a spatial anchor with nodeIds and the rect they occupy), a region (a spatial anchor with width and height), a quoted passage of a note's body, a quoted passage of a text node's text (a text anchor naming the node), or the document as a whole (kind: document); reply to one; resolve or reopen one. Threads are never deleted, by an agent or by a person: resolving is the only way to close one. Returns every thread the document holds, so a newly opened thread's id needs no second read.",
    inputSchema: threadEditInputSchema,
    outputSchema: threadEditOutputSchema,
    async execute(input: ThreadEditInput): Promise<ThreadEditOutput> {
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const { doc } = await loadDocument(deps, input.workspaceId, input.documentId)

      // Unlike `wb_canvas_edit`, nothing here is validated against a document
      // KIND: the whole point of decision 6 is that the layer is the same
      // plane on every format. What varies is the anchor, and its union
      // already carries that.
      const held = new Set(readAnnotations(doc).map((thread) => thread.id))
      const now = new Date().toISOString()
      for (const [index, op] of input.ops.entries()) {
        applyThreadOp({ doc, held, now, index }, op)
      }

      await saveDocumentSnapshot(deps, input.workspaceId, input.documentId, doc)

      return {
        threads: readAnnotations(doc).map((thread) => ({
          id: thread.id,
          status: thread.status,
          messageCount: thread.messages.length,
        })),
      }
    },
  }
}
