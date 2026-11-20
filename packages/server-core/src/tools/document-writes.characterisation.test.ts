// What the facet, document-set, create, linkify and reference-follow writes
// leave in the stored document, as the Loro readers answer it, and what each
// save hands the store and the document-written observer. The golden files are
// recorded from the tools' behaviour before they wrote through the engine, so
// a change of how they write stays a change of how they write and never of
// what they store.
import {
  setEdgeLock,
  setNodeLock,
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
  writeTrustFacets,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { followReferencesAfterRename } from '../references/follow-rename.js'
import {
  DOCUMENT_ID,
  golden,
  NOW,
  type Rig,
  record,
  rig,
  SECOND_DOCUMENT_ID,
  seed,
  WORKSPACE_ID,
} from '../test-utils/write-characterisation.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSetOperation } from './document-set.js'
import { createFacetSetTool } from './facet-set.js'
import { linkifyMentions } from './linkify-mentions.js'

const BOARD: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 200, height: 60, text: 'Alpha', tags: ['x', 'old'] }),
    textNode({ id: 'b', x: 300, y: 0, width: 200, height: 60, text: 'Beta' }),
    textNode({ id: 'c', x: 600, y: 0, width: 200, height: 60, text: 'Gamma', tags: ['old'] }),
  ],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' }, tags: ['old'] }],
  tags: ['kept', 'old'],
}

const DIRECTORY = 'document-writes'

const seedBoard = (rigged: Rig, locks: { node?: string; edge?: string } = {}) =>
  seed(rigged, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, BOARD)
    writeFacets(doc, { 'example.sample/v1': { status: 'open' } })
    if (locks.node !== undefined) setNodeLock(doc, locks.node, true)
    if (locks.edge !== undefined) setEdgeLock(doc, locks.edge, true)
  })

const seedNote = (rigged: Rig, documentId: string = DOCUMENT_ID, path = 'doc') =>
  seed(
    rigged,
    (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, 'one two three')
      writeCoreFacets(doc, { type: 'note', tags: ['t1', 'old'] })
      writeFacets(doc, { 'example.sample/v1': { status: 'open' } })
    },
    documentId,
    path,
  ).then(() =>
    rigged.store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId,
      path,
      kind: 'markdown',
    }),
  )

/** What a refused call left behind: the error, and the same record of the store. */
async function refused(rigged: Rig, call: () => Promise<unknown>, ids = [DOCUMENT_ID]) {
  const error = await call().then(
    () => null,
    (caught: unknown) => ({
      name: caught instanceof Error ? caught.name : typeof caught,
      message: caught instanceof Error ? caught.message : String(caught),
    }),
  )
  return { error, ...(await record(rigged, ids)) }
}

describe('what wb_facet_set stores', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const facetSet = (rigged: Rig, input: Record<string, unknown>) =>
    createFacetSetTool(rigged.deps).execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      ...input,
    } as never)

  test('a node: a registered facet and a tag change', async () => {
    const rigged = rig()
    await seedBoard(rigged)
    const answer = await facetSet(rigged, {
      nodeId: 'a',
      facets: { 'visual.shape/v0': { kind: 'hexagon' } },
      tags: { add: ['n'], remove: ['x'] },
    })
    await golden(DIRECTORY, 'facet-set-node', { answer, ...(await record(rigged)) })
  })

  test('an edge: an extension facet cleared by null and a tag added', async () => {
    const rigged = rig()
    await seedBoard(rigged)
    await facetSet(rigged, { edgeId: 'e1', facets: { 'example.sample/v1': { status: 'a' } } })
    const answer = await facetSet(rigged, {
      edgeId: 'e1',
      facets: { 'example.other/v1': { v: 1 }, 'example.sample/v1': null },
      tags: { add: ['z'] },
    })
    await golden(DIRECTORY, 'facet-set-edge', { answer, ...(await record(rigged)) })
  })

  test('the canvas: a facet, and a rename that reaches every node and edge', async () => {
    const rigged = rig()
    await seedBoard(rigged, { node: 'b' })
    const answer = await facetSet(rigged, {
      target: 'canvas',
      facets: { 'visual.edges/v0': { routing: 'curved' } },
      tags: { rename: [{ from: 'old', to: 'new' }], add: ['board'] },
    })
    await golden(DIRECTORY, 'facet-set-canvas', { answer, ...(await record(rigged)) })
  })

  test('a locked node refuses its own facet write and writes nothing', async () => {
    const rigged = rig()
    await seedBoard(rigged, { node: 'b' })
    await golden(
      DIRECTORY,
      'facet-set-locked-node',
      await refused(rigged, () =>
        facetSet(rigged, { nodeId: 'b', facets: { 'example.x/v1': {} } }),
      ),
    )
  })

  test('a locked edge refuses a tag write and writes nothing', async () => {
    const rigged = rig()
    await seedBoard(rigged, { edge: 'e1' })
    await golden(
      DIRECTORY,
      'facet-set-locked-edge',
      await refused(rigged, () => facetSet(rigged, { edgeId: 'e1', tags: { add: ['q'] } })),
    )
  })

  test('a rename that would reach a locked node refuses the whole batch', async () => {
    const rigged = rig()
    await seedBoard(rigged, { node: 'a' })
    await golden(
      DIRECTORY,
      'facet-set-locked-rename',
      await refused(rigged, () =>
        facetSet(rigged, { target: 'canvas', tags: { rename: [{ from: 'old', to: 'new' }] } }),
      ),
    )
  })

  test('two markdown documents: facets merged and core tags changed in one call', async () => {
    const rigged = rig()
    await seedNote(rigged)
    await seedNote(rigged, SECOND_DOCUMENT_ID, 'doc2')
    const answer = await facetSet(rigged, {
      documentIds: [DOCUMENT_ID, SECOND_DOCUMENT_ID],
      facets: { 'example.priority/v1': { level: 'high' } },
      tags: { add: ['added'], remove: ['t1'], rename: [{ from: 'old', to: 'newer' }] },
    })
    await golden(DIRECTORY, 'facet-set-markdown', {
      answer,
      ...(await record(rigged, [DOCUMENT_ID, SECOND_DOCUMENT_ID])),
    })
  })

  test('a document that was never saved is created holding the facet', async () => {
    const rigged = rig()
    rigged.store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      path: 'doc',
    })
    const answer = await facetSet(rigged, { facets: { 'example.kanban/v1': { status: 'todo' } } })
    await golden(DIRECTORY, 'facet-set-never-saved', { answer, ...(await record(rigged)) })
  })

  test('a markdown document with no frontmatter cannot take a tag, and nothing is written', async () => {
    const rigged = rig()
    await seed(rigged, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, 'bare')
    })
    await golden(
      DIRECTORY,
      'facet-set-no-frontmatter',
      await refused(rigged, () => facetSet(rigged, { tags: { add: ['t'] } })),
    )
  })

  test('a spatial document refuses a document-site facet before any write', async () => {
    const rigged = rig()
    await seedBoard(rigged)
    await golden(
      DIRECTORY,
      'facet-set-kind-mismatch',
      await refused(rigged, () => facetSet(rigged, { facets: { 'example.x/v1': {} } })),
    )
  })
})

describe('what document.set stores', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const documentSet = (rigged: Rig, markdown: string, actor?: string) =>
    createDocumentSetOperation(rigged.deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown,
      ...(actor === undefined ? {} : { actor }),
    } as never)

  const note = (body: string, generated = '') =>
    `---\ntype: note\ntitle: Plan\ntags:\n  - alpha\nfacets:\n  example.sample/v1:\n    status: open\n${generated}---\n${body}`

  test('a document that was never saved is created as markdown with its trust facets', async () => {
    const rigged = rig()
    rigged.store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      path: 'doc',
    })
    const answer = await documentSet(rigged, note('First body.'), 'agent/1')
    await golden(DIRECTORY, 'document-set-create', {
      answer,
      name: (
        await rigged.store.documentIndex.resolveDocumentById({
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
        })
      )?.name,
      ...(await record(rigged)),
    })
  })

  test('an existing document is overwritten, and a declared stamp is kept until an edit echoes it', async () => {
    const rigged = rig()
    await seedNote(rigged)
    const generated = 'generated:\n  by: import/1\n  at: "2020-01-01T00:00:00.000Z"\n'
    const answers = [
      await documentSet(rigged, note('Imported body.', generated)),
      await documentSet(rigged, note('Edited body.', generated), 'human:me'),
    ]
    await golden(DIRECTORY, 'document-set-overwrite', { answers, ...(await record(rigged)) })
  })

  test('a document with no kind and a canvas refuses and writes nothing', async () => {
    const rigged = rig()
    await seed(rigged, (doc) => writeSpatialCanvas(doc, BOARD))
    await golden(
      DIRECTORY,
      'document-set-canvas-without-kind',
      await refused(rigged, () => documentSet(rigged, note('x'))),
    )
  })

  test('a spatial document refuses and writes nothing', async () => {
    const rigged = rig()
    await seedBoard(rigged)
    await golden(
      DIRECTORY,
      'document-set-spatial',
      await refused(rigged, () => documentSet(rigged, note('x'))),
    )
  })

  test('a document that already carries trust facets and a verified stamp keeps the verification', async () => {
    const rigged = rig()
    await seed(rigged, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, 'old')
      writeTrustFacets(doc, { generated: { by: 'a/1', at: '2021-01-01T00:00:00.000Z' } })
    })
    const verified = 'verified:\n  by: human:me\n  at: "2022-01-01T00:00:00.000Z"\n'
    const answer = await documentSet(rigged, note('new body', verified))
    await golden(DIRECTORY, 'document-set-verified', { answer, ...(await record(rigged)) })
  })
})

const CREATE_WORKSPACE = '01RAZ9RNDPVKYWSQEWJ2PKYRZJ'

describe('what document creation stores', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('a spatial document is stored holding its kind and nothing else', async () => {
    const rigged = rig()
    await rigged.deps.documentIndex.createWorkspace({ workspaceId: CREATE_WORKSPACE })
    const created = await wbDocumentCreate(rigged.deps, {
      workspaceId: CREATE_WORKSPACE,
      path: 'board',
      kind: 'spatial',
    })
    await golden(DIRECTORY, 'document-create-spatial', {
      path: created.path,
      ...(await record(rigged, [created.documentId])),
    })
  })

  test('a markdown document with a body is stored by two saves, the kind then the content', async () => {
    const rigged = rig()
    await rigged.deps.documentIndex.createWorkspace({ workspaceId: CREATE_WORKSPACE })
    const created = await wbDocumentCreate(rigged.deps, {
      workspaceId: CREATE_WORKSPACE,
      path: 'note',
      kind: 'markdown',
      markdown: '---\ntype: note\ntags:\n  - alpha\n---\nBody at birth.',
    })
    await golden(DIRECTORY, 'document-create-markdown', {
      path: created.path,
      ...(await record(rigged, [created.documentId])),
    })
  })
})

describe('what linkify-mentions stores', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const target = (rigged: Rig) =>
    rigged.store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: SECOND_DOCUMENT_ID,
      path: 'design/login',
      kind: 'markdown',
      name: 'Login flow',
    })

  test('a markdown body: each unlinked mention becomes a reference, by splices', async () => {
    const rigged = rig()
    await seed(rigged, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, 'The Login flow is here. Login flow again, and [[Login flow]] stays.')
    })
    rigged.store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      path: 'doc',
      kind: 'markdown',
    })
    target(rigged)
    const answer = await linkifyMentions(rigged.deps, {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      targetDocumentId: SECOND_DOCUMENT_ID,
    } as never)
    await golden(DIRECTORY, 'linkify-markdown', { answer, ...(await record(rigged)) })
  })

  test('a canvas: only the text nodes that mention the name are rewritten', async () => {
    const rigged = rig()
    await seed(rigged, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [
          textNode({ id: 't1', x: 0, y: 0, width: 200, height: 60, text: 'Login flow notes' }),
          textNode({ id: 't2', x: 0, y: 100, width: 200, height: 60, text: 'unrelated' }),
        ],
        edges: [],
      })
    })
    target(rigged)
    const answer = await linkifyMentions(rigged.deps, {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      targetDocumentId: SECOND_DOCUMENT_ID,
    } as never)
    await golden(DIRECTORY, 'linkify-canvas', { answer, ...(await record(rigged)) })
  })

  test('a document that mentions nothing is not saved', async () => {
    const rigged = rig()
    await seed(rigged, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, 'nothing to link')
    })
    rigged.store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      path: 'doc',
      kind: 'markdown',
    })
    target(rigged)
    const answer = await linkifyMentions(rigged.deps, {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      targetDocumentId: SECOND_DOCUMENT_ID,
    } as never)
    await golden(DIRECTORY, 'linkify-nothing', { answer, ...(await record(rigged)) })
  })
})

describe('what following a rename stores', () => {
  const THIRD_DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V9'

  test('references written as the old path are repointed, in a note and on a board, and the rest is untouched', async () => {
    const rigged = rig()
    rigged.store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: SECOND_DOCUMENT_ID,
      path: 'design/login',
      kind: 'markdown',
      name: 'Login flow',
    })
    await seed(
      rigged,
      (doc) => {
        writeDocumentKind(doc, 'markdown')
        writeMarkdownBody(doc, 'see [[design/login]] and [[Login flow]] and [[unrelated]]')
      },
      DOCUMENT_ID,
    )
    rigged.store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      path: 'doc',
      kind: 'markdown',
    })
    await seed(
      rigged,
      (doc) => {
        writeDocumentKind(doc, 'spatial')
        writeSpatialCanvas(doc, {
          nodes: [
            textNode({
              id: 't1',
              x: 0,
              y: 0,
              width: 200,
              height: 60,
              text: 'see [[design/login]]',
            }),
            fileNode({ id: 'f1', x: 0, y: 100, width: 100, height: 40, file: 'design/login' }),
            textNode({ id: 't2', x: 0, y: 200, width: 200, height: 60, text: 'unrelated' }),
          ],
          edges: [],
        })
      },
      THIRD_DOCUMENT_ID,
      'board',
    )
    const entriesBefore = await rigged.deps.documentIndex.listDocuments({
      workspaceId: WORKSPACE_ID,
    })
    await rigged.deps.documentIndex.moveDocument({
      workspaceId: WORKSPACE_ID,
      from: 'design/login',
      to: 'archive/login',
    })
    const result = await followReferencesAfterRename(rigged.deps, {
      workspaceId: WORKSPACE_ID,
      entriesBefore,
      moves: [{ movedId: SECOND_DOCUMENT_ID, from: 'design/login', to: 'archive/login' }],
    })
    await golden(DIRECTORY, 'follow-rename', {
      result: {
        updated: result.updatedDocumentIds.map((id) => (id === DOCUMENT_ID ? 'note' : 'board')),
        failed: result.failedDocumentIds,
      },
      ...(await record(rigged, [DOCUMENT_ID, THIRD_DOCUMENT_ID])),
    })
  })
})
