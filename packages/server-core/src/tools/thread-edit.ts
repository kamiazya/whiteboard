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

export function createThreadEditTool(deps: ServerDeps) {
  return {
    name: 'wb_thread_edit' as const,
    description:
      "Comment on any document — a spatial canvas or a markdown note — through its annotation layer: open a thread anchored to a node, a point, or a quoted passage; reply to one; resolve or reopen one. Threads are never deleted, by an agent or by a person: resolving is the only way to close one. Returns every thread the document holds, so a newly opened thread's id needs no second read.",
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
        switch (op.op) {
          case 'thread.add': {
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
            break
          }
          case 'message.add': {
            // Refused rather than silently accepted: `writeThreadMessage` is a
            // no-op for a thread this replica does not hold, because opening a
            // container is the one write that cannot merge — two replicas that
            // create one under the same key with no common ancestor keep only
            // one side. A quiet no-op would report success over a lost reply.
            if (!held.has(op.threadId)) {
              throw new ThreadEditError(
                index,
                op.op,
                `thread "${op.threadId}" is not on this document`,
              )
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
            break
          }
          case 'thread.resolve': {
            if (!held.has(op.threadId)) {
              throw new ThreadEditError(
                index,
                op.op,
                `thread "${op.threadId}" is not on this document`,
              )
            }
            setCommentThreadStatus(doc, op.threadId, op.resolved === false ? 'open' : 'resolved')
            break
          }
        }
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
