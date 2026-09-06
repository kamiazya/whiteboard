import {
  readMarkdownBody,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { TextAnchor } from '@kamiazya/whiteboard-model'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { bodyEditInputSchema, createBodyEditTool } from './body-edit.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { DocumentKindMismatchError } from './errors.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

const docRef = { kind: 'document' as const, workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }

async function seedMarkdown(store: FakeDocumentStore, body: string): Promise<void> {
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1_000_000)
  await store.saveSnapshot({
    docRef,
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

async function seedSpatial(store: FakeDocumentStore): Promise<void> {
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
    edges: [],
  })
  const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1_000_000)
  await store.saveSnapshot({
    docRef,
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

/** What the store actually holds, rather than what the tool says it wrote. */
async function storedBody(store: FakeDocumentStore): Promise<string> {
  const saved = await store.loadSnapshot({ docRef })
  if (saved === null) throw new Error('nothing saved')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(saved.manifest, saved.chunks))
  return readMarkdownBody(doc)
}

function makeDeps(store: FakeDocumentStore): ServerDeps {
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

function passage(
  body: string,
  exact: string,
  quote: Partial<TextAnchor['quote']> = {},
): TextAnchor {
  const start = body.indexOf(exact)
  if (start < 0) throw new Error(`test bug: ${JSON.stringify(exact)} is not in the seeded body`)
  return { kind: 'text', quote: { exact, ...quote }, start, end: start + exact.length }
}

describe('wb_body_edit', () => {
  test('replaces one passage and leaves the rest of the body alone', async () => {
    const store = new FakeDocumentStore()
    const body = '# Plan\n\nThe plan is to ship on Thursday.\n'
    await seedMarkdown(store, body)

    const result = await createBodyEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          id: 'c1',
          op: 'body.replace',
          anchor: passage(body, 'Thursday'),
          text: 'Friday',
          assumed: 'Thursday',
        },
      ],
    })

    expect(result.applied).toBe(1)
    expect(await storedBody(store)).toBe('# Plan\n\nThe plan is to ship on Friday.\n')
  })

  test('finds the passage by its quote after an edit moved it', async () => {
    const store = new FakeDocumentStore()
    // The anchor is built against the body BEFORE the note above it existed,
    // so its offsets are stale by exactly that prefix — the case a line
    // number cannot survive and a quote can.
    const original = 'The plan is to ship on Thursday.\n'
    const anchor = passage(original, 'Thursday')
    await seedMarkdown(store, `> Note added since.\n\n${original}`)

    await createBodyEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ id: 'c1', op: 'body.replace', anchor, text: 'Friday', assumed: 'Thursday' }],
    })

    expect(await storedBody(store)).toBe('> Note added since.\n\nThe plan is to ship on Friday.\n')
  })

  test('refuses the whole batch when a passage is no longer what was assumed', async () => {
    const store = new FakeDocumentStore()
    const body = 'The plan is to ship on Thursday.\n'
    await seedMarkdown(store, body)

    await expect(
      createBodyEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: passage(body, 'Thursday'),
            text: 'Friday',
            assumed: 'Wednesday',
          },
        ],
      }),
    ).rejects.toThrow(/c1/)

    expect(await storedBody(store)).toBe(body)
  })

  test('refuses the whole batch when one passage of several is gone', async () => {
    const store = new FakeDocumentStore()
    const body = 'The plan is to ship on Thursday.\n'
    await seedMarkdown(store, body)

    await expect(
      createBodyEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: passage(body, 'Thursday'),
            text: 'Friday',
            assumed: 'Thursday',
          },
          {
            id: 'c2',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'nowhere in this body' }, start: 0, end: 20 },
            text: 'x',
            assumed: 'nowhere in this body',
          },
        ],
      }),
    ).rejects.toThrow(/c2/)

    // The first op was applicable; nothing was written because the second
    // was not. One call is one decision.
    expect(await storedBody(store)).toBe(body)
  })

  test('applies several passages in one call, later ones unshifted by earlier ones', async () => {
    const store = new FakeDocumentStore()
    const body = 'Ship on Thursday. Review on Thursday too.\n'
    await seedMarkdown(store, body)

    await createBodyEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          id: 'c1',
          op: 'body.replace',
          anchor: passage(body, 'Ship on Thursday'),
          text: 'Ship on Monday',
          assumed: 'Ship on Thursday',
        },
        {
          id: 'c2',
          op: 'body.replace',
          anchor: passage(body, 'Review on Thursday'),
          text: 'Review on Wednesday',
          assumed: 'Review on Thursday',
        },
      ],
    })

    expect(await storedBody(store)).toBe('Ship on Monday. Review on Wednesday too.\n')
  })

  test('refuses a spatial document by name, rather than writing prose onto a canvas', async () => {
    const store = new FakeDocumentStore()
    await seedSpatial(store)

    await expect(
      createBodyEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'hello' }, start: 0, end: 5 },
            text: 'x',
            assumed: 'hello',
          },
        ],
      }),
    ).rejects.toThrow(DocumentKindMismatchError)
  })

  test('refuses a document the workspace does not hold', async () => {
    const store = new FakeDocumentStore()
    await expect(
      createBodyEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'x' }, start: 0, end: 1 },
            text: 'y',
            assumed: 'x',
          },
        ],
      }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })
})

// Kept honest about what this increment does NOT do: the schema names a
// mode so the wire shape is settled, but only `apply` exists until prose
// gets the content-proposes default `wb_canvas_edit` already has.
//
// Asserted on the SCHEMA, not through `execute`: the MCP SDK validates
// arguments at registration, so `execute` receives input that has already
// parsed. Calling it with an unparsed object proves nothing about what the
// tool accepts.
describe('the mode this increment ships', () => {
  test('accepts apply and refuses propose', () => {
    const ops = [
      {
        id: 'c1',
        op: 'body.replace',
        anchor: { kind: 'text', quote: { exact: 'body' }, start: 0, end: 4 },
        text: 'x',
        assumed: 'body',
      },
    ]
    const base = { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, ops }

    expect(bodyEditInputSchema.safeParse({ ...base, mode: 'apply' }).success).toBe(true)
    expect(bodyEditInputSchema.safeParse({ ...base, mode: 'propose' }).success).toBe(false)
  })

  test("refuses an op carrying a status, which is the document's verdict to keep", () => {
    const parsed = bodyEditInputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          id: 'c1',
          status: 'adopted',
          op: 'body.replace',
          anchor: { kind: 'text', quote: { exact: 'body' }, start: 0, end: 4 },
          text: 'x',
          assumed: 'body',
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })
})
