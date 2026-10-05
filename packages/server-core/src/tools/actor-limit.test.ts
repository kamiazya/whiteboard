import { OKF_ACTOR_MAX_CHARS, okfActorInputSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { apiErrorReason } from '../api-errors.js'
import { createServer } from '../create-server.js'
import { loadDocument } from '../document-io.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { bodyEditInputSchema } from './body-edit.js'
import { canvasEditInputSchema } from './canvas-edit-ops.js'
import { wbDocumentCreateInputSchema } from './document-crud.schemas.js'
import { documentSetInputSchema } from './document-set.js'
import { createThreadEditTool } from './thread-edit.js'
import { createWorkspaceEditTool, workspaceEditInputSchema } from './workspace-edit.js'

const WS = 'ws-actors'
const DOC = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
/**
 * Characters a snapshot cannot compress away, so what is stored measures the
 * actor rather than how well a run of one letter packs.
 */
function incompressible(length: number): string {
  let seed = 1
  return Array.from({ length }, () => {
    seed = (seed * 48271) % 2147483647
    return (seed % 36).toString(36)
  }).join('')
}
const overLimit = `agent/${incompressible(OKF_ACTOR_MAX_CHARS)}`
const atLimit = `agent/${incompressible(OKF_ACTOR_MAX_CHARS - 'agent/'.length)}`

const threadEditInputSchema = createThreadEditTool(makeTestDeps()).inputSchema

/** Every tool and /api/v1 field an actor or an author is written through. */
const WRITERS: ReadonlyArray<readonly [string, (actor: string) => unknown]> = [
  [
    'POST /api/v1 documents',
    (actor) =>
      wbDocumentCreateInputSchema.safeParse({
        workspaceId: WS,
        path: 'n',
        kind: 'markdown',
        actor,
      }),
  ],
  [
    'wb_workspace_edit actor',
    (actor) =>
      workspaceEditInputSchema.safeParse({
        workspaceId: WS,
        actor,
        ops: [{ op: 'document.create', path: 'n', kind: 'markdown' }],
      }),
  ],
  [
    'wb_document_set actor',
    (actor) =>
      documentSetInputSchema.safeParse({ workspaceId: WS, documentId: DOC, markdown: 'x', actor }),
  ],
  [
    'wb_thread_edit thread.add author',
    (author) =>
      threadEditInputSchema.safeParse({
        workspaceId: WS,
        documentId: DOC,
        ops: [{ op: 'thread.add', anchor: { kind: 'document' }, body: 'hi', author }],
      }),
  ],
  [
    'wb_thread_edit message.add author',
    (author) =>
      threadEditInputSchema.safeParse({
        workspaceId: WS,
        documentId: DOC,
        ops: [{ op: 'message.add', threadId: 'th-1', body: 'hi', author }],
      }),
  ],
  [
    'wb_canvas_edit proposal author',
    (author) =>
      canvasEditInputSchema.safeParse({
        workspaceId: WS,
        documentId: DOC,
        mode: 'propose',
        author,
        ops: [{ op: 'node.remove', id: 'n1' }],
      }),
  ],
  [
    'wb_body_edit proposal author',
    (author) =>
      bodyEditInputSchema.safeParse({
        workspaceId: WS,
        documentId: DOC,
        mode: 'propose',
        author,
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'a' }, start: 0, end: 1 },
            text: 'b',
            assumed: 'a',
          },
        ],
      }),
  ],
]

function refusalMessages(parsed: unknown): string[] {
  const result = parsed as { success: boolean; error?: { issues: { message: string }[] } }
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? [])
}

describe('the length of an actor is declared once', () => {
  it('holds an actor to 256 characters', () => {
    // A literal, not the constant: every other case reads the limit back
    // from itself, so a changed limit would pass them all.
    expect(OKF_ACTOR_MAX_CHARS).toBe(256)
  })

  it.each(WRITERS)('%s refuses one character past the limit, in the same words', (_w, parse) => {
    const expected = refusalMessages(okfActorInputSchema.safeParse(overLimit))
    expect(expected).toHaveLength(1)
    expect(refusalMessages(parse(overLimit))).toEqual(expected)
  })

  it.each(WRITERS)('%s accepts an actor of exactly the limit', (_w, parse) => {
    expect(refusalMessages(parse(atLimit))).toEqual([])
  })

  it('answers 400 to an over-long actor on POST /api/v1 documents, minting nothing', async () => {
    const deps = makeTestDeps({ documentTeardown: inMemoryDocumentTeardown() })
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    const { app } = createServer(deps)
    const res = await app.request(`/api/v1/workspaces/${WS}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'n', kind: 'markdown', actor: overLimit }),
    })
    expect(res.status).toBe(400)
    expect(apiErrorReason(await res.json())).toContain(`${OKF_ACTOR_MAX_CHARS}-character limit`)
    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toEqual([])
  })
})

describe('a batch actor stamped on every op', () => {
  async function storedBytes(actor: string, ops: number): Promise<number> {
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    const out = await createWorkspaceEditTool(deps).execute({
      workspaceId: WS,
      actor,
      ops: Array.from({ length: ops }, (_, i) => ({
        op: 'document.create' as const,
        path: `n${i}`,
        kind: 'markdown' as const,
        markdown: 'x',
      })),
    })
    let total = 0
    for (const result of out.results) {
      if (!('documentId' in result) || typeof result.documentId !== 'string') continue
      const { doc } = await loadDocument(deps, WS, result.documentId)
      total += doc.export({ mode: 'snapshot' }).byteLength
    }
    // The subject is present: every op wrote a document carrying the stamp.
    expect(out.results).toHaveLength(ops)
    return total
  }

  it('grows what is stored by a bounded multiple of the actor per op', async () => {
    const ops = 20
    const short = await storedBytes('agent/1', ops)
    const long = await storedBytes(atLimit, ops)
    // The stamp is kept in the frontmatter text and in its history, so an op
    // stores the actor about twice; four times leaves room for encoding.
    expect(long - short).toBeLessThan(ops * OKF_ACTOR_MAX_CHARS * 4)
    expect(long).toBeGreaterThan(short)
  })
})
