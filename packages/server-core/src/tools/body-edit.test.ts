import {
  readMarkdownBody,
  readProposals,
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

/** The proposals plane as the store actually holds it. */
async function storedProposals(store: FakeDocumentStore) {
  const saved = await store.loadSnapshot({ docRef })
  if (saved === null) throw new Error('nothing saved')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(saved.manifest, saved.chunks))
  return readProposals(doc)
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

  test('refuses two passages that overlap, rather than splicing a third thing', async () => {
    const store = new FakeDocumentStore()
    // Each op is applicable on its own — 'abc' → 'Xdef', 'bcd' → 'aYef' — and
    // each passes the assumption check against the body as placed. Applied
    // together they produce 'Xf', which is neither. Placement reads ONE body,
    // so overlap is the case where back-to-front application stops being
    // equivalent to applying each op to the body the caller saw.
    await seedMarkdown(store, 'abcdef')

    await expect(
      createBodyEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'abc' }, start: 0, end: 3 },
            text: 'X',
            assumed: 'abc',
          },
          {
            id: 'c2',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'bcd' }, start: 1, end: 4 },
            text: 'Y',
            assumed: 'bcd',
          },
        ],
      }),
    ).rejects.toThrow(/c2.*c1|c1.*c2/)

    expect(await storedBody(store)).toBe('abcdef')
  })

  test('allows two passages that merely touch, since neither reaches into the other', async () => {
    const store = new FakeDocumentStore()
    await seedMarkdown(store, 'abcdef')

    await createBodyEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          id: 'c1',
          op: 'body.replace',
          anchor: { kind: 'text', quote: { exact: 'abc' }, start: 0, end: 3 },
          text: 'X',
          assumed: 'abc',
        },
        {
          id: 'c2',
          op: 'body.replace',
          anchor: { kind: 'text', quote: { exact: 'def' }, start: 3, end: 6 },
          text: 'Y',
          assumed: 'def',
        },
      ],
    })

    expect(await storedBody(store)).toBe('XY')
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

describe('the mode (ADR-0029 decision 7, applied to prose)', () => {
  test('proposes by default, leaving the body exactly as it was', async () => {
    const store = new FakeDocumentStore()
    const body = 'The plan is to ship on Thursday.\n'
    await seedMarkdown(store, body)

    const result = await createBodyEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
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

    expect(result.applied).toBe(0)
    expect(result.proposed?.id).toBeDefined()
    expect(await storedBody(store)).toBe(body)

    const proposals = await storedProposals(store)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.changes).toEqual([
      {
        id: 'c1',
        status: 'open',
        op: 'body.replace',
        anchor: passage(body, 'Thursday'),
        text: 'Friday',
        assumed: 'Thursday',
      },
    ])
  })

  test('an explicit apply still changes the document and stores no proposal', async () => {
    const store = new FakeDocumentStore()
    const body = 'The plan is to ship on Thursday.\n'
    await seedMarkdown(store, body)

    await createBodyEditTool(makeDeps(store)).execute({
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

    expect(await storedBody(store)).toBe('The plan is to ship on Friday.\n')
    expect(await storedProposals(store)).toHaveLength(0)
  })

  test('a proposal keeps a stale assumption instead of refusing it', async () => {
    const store = new FakeDocumentStore()
    // Decision 5: a proposal FOLLOWS the document. The passage is still
    // there, so the proposal can be drawn; that it now reads something else
    // is a collision for the PERSON to see when they adopt, not a reason to
    // refuse the proposal at the door. `apply` is the path that refuses.
    const body = 'The plan is to ship on Thursday.\n'
    await seedMarkdown(store, body)

    await createBodyEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        {
          id: 'c1',
          op: 'body.replace',
          anchor: passage(body, 'Thursday'),
          text: 'Friday',
          assumed: 'Wednesday',
        },
      ],
    })

    const proposals = await storedProposals(store)
    expect(proposals[0]?.changes[0]).toMatchObject({ assumed: 'Wednesday', status: 'open' })
  })

  test('refuses a proposal whose passage is nowhere in the body', async () => {
    const store = new FakeDocumentStore()
    await seedMarkdown(store, 'The plan is to ship on Thursday.\n')

    await expect(
      createBodyEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'nowhere in this body' }, start: 0, end: 20 },
            text: 'x',
            assumed: 'nowhere in this body',
          },
        ],
      }),
    ).rejects.toThrow(/c1/)

    expect(await storedProposals(store)).toHaveLength(0)
  })

  test('refuses overlapping passages when proposing, not only when applying', async () => {
    const store = new FakeDocumentStore()
    await seedMarkdown(store, 'abcdef')

    await expect(
      createBodyEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'abc' }, start: 0, end: 3 },
            text: 'X',
            assumed: 'abc',
          },
          {
            id: 'c2',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'bcd' }, start: 1, end: 4 },
            text: 'Y',
            assumed: 'bcd',
          },
        ],
      }),
    ).rejects.toThrow(/overlaps/)

    expect(await storedProposals(store)).toHaveLength(0)
  })

  test('refuses two ops sharing one change id, which an Adopt could not tell apart', async () => {
    const store = new FakeDocumentStore()
    const body = 'Ship on Thursday. Review on Friday.\n'
    await seedMarkdown(store, body)

    await expect(
      createBodyEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [
          {
            id: 'same',
            op: 'body.replace',
            anchor: passage(body, 'Thursday'),
            text: 'Monday',
            assumed: 'Thursday',
          },
          {
            id: 'same',
            op: 'body.replace',
            anchor: passage(body, 'Friday'),
            text: 'Tuesday',
            assumed: 'Friday',
          },
        ],
      }),
    ).rejects.toThrow(/same/)
  })

  test('a second call under one proposalId adds to that proposal', async () => {
    const store = new FakeDocumentStore()
    const body = 'Ship on Thursday. Review on Friday.\n'
    await seedMarkdown(store, body)
    const tool = createBodyEditTool(makeDeps(store))

    const first = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        {
          id: 'c1',
          op: 'body.replace',
          anchor: passage(body, 'Thursday'),
          text: 'Monday',
          assumed: 'Thursday',
        },
      ],
    })
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      proposalId: first.proposed?.id,
      ops: [
        {
          id: 'c2',
          op: 'body.replace',
          anchor: passage(body, 'Friday'),
          text: 'Tuesday',
          assumed: 'Friday',
        },
      ],
    })

    const proposals = await storedProposals(store)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.changes.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
  })

  test('refuses a mode the schema does not name', () => {
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
    expect(bodyEditInputSchema.safeParse({ ...base, mode: 'propose' }).success).toBe(true)
    expect(bodyEditInputSchema.safeParse(base).success).toBe(true)
    expect(bodyEditInputSchema.safeParse({ ...base, mode: 'draft' }).success).toBe(false)
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
