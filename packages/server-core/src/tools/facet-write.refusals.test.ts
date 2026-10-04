/**
 * Registered-facet write validation (ADR-0013 decisions 6 and 10) is a rule
 * about a WRITE, not about one tool: the same invalid payload must be refused
 * by every writer an agent can reach, and refused before anything is stored.
 *
 * One table of invalid writes, run against every writer whose target the write
 * names. A writer added later is exempt from nothing until a row says so, and
 * the rows' own count is asserted so a table that quietly emptied reads red.
 */
import {
  readCoreFacets,
  readFacets,
  readSpatialCanvas,
  setEdgeLock,
  setNodeLock,
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { loadDocument } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSetTool } from './document-set.js'
import { createFacetSetTool } from './facet-set.js'

const WORKSPACE_ID = 'ws-1'
const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'

/** Boxes `a` and `b`, the relation `e` between them, and the stroke `l`. */
const BOARD: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 80, height: 40, text: 'A' }),
    textNode({ id: 'b', x: 300, y: 0, width: 80, height: 40, text: 'B' }),
  ],
  edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
  lines: [
    {
      id: 'l',
      from: { kind: 'point', point: { x: 0, y: 100 } },
      to: { kind: 'point', point: { x: 50, y: 100 } },
    },
  ],
}

interface Fixture {
  readonly deps: ServerDeps
  readonly store: FakeDocumentStore
}

async function fixture(): Promise<Fixture> {
  const store = new FakeDocumentStore()
  await seedDoc(store, CANVAS_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, BOARD)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID, 'board')
  await seedDoc(store, NOTE_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeCoreFacets(doc, { type: 'note' })
    writeFacets(doc, {})
  })
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: NOTE_ID,
    path: 'note',
    kind: 'markdown',
  })
  return {
    store,
    deps: makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
  }
}

type Target = 'node' | 'edge' | 'document'

/** A write no registered facet accepts, and what the refusal says about it. */
interface InvalidWrite {
  readonly label: string
  readonly target: Target
  readonly key: string
  readonly payload: unknown
  readonly refusal: RegExp
}

const INVALID_WRITES: readonly InvalidWrite[] = [
  {
    label: 'an enum value the schema does not list',
    target: 'node',
    key: 'visual.shape/v0',
    payload: { kind: 'blob' },
    refusal: /payload for "visual\.shape\/v0" is invalid: kind/,
  },
  {
    label: 'a key the schema does not declare, beside a valid one',
    target: 'node',
    key: 'visual.shape/v0',
    payload: { kind: 'ellipse', bogus: 1 },
    refusal: /Unrecognized key: "bogus"/,
  },
  {
    label: 'a facet whose targets exclude the object',
    target: 'node',
    key: 'visual.ink/v0',
    payload: { group: 'g' },
    refusal: /its targets are \[edge\], and this write targets a node/,
  },
  {
    label: 'a misspelt key on an edge',
    target: 'edge',
    key: 'visual.edges/v0',
    payload: { route: 'curved' },
    refusal: /Unrecognized key: "route"/,
  },
  {
    label: 'an enum value the edge schema does not list',
    target: 'edge',
    key: 'visual.edges/v0',
    payload: { routing: 'zigzag' },
    refusal: /payload for "visual\.edges\/v0" is invalid: routing/,
  },
  {
    label: 'a stencil no plugin registered',
    target: 'node',
    key: 'visual.stencil/v0',
    payload: { stencil: 'visual.nope' },
    refusal: /names stencils asset "visual\.nope", which no plugin registered/,
  },
  {
    label: 'a field of the wrong type',
    target: 'edge',
    key: 'visual.ink/v0',
    payload: { group: 5 },
    refusal: /payload for "visual\.ink\/v0" is invalid: group/,
  },
  {
    label: 'a symbol kind the schema does not list',
    target: 'document',
    key: 'visual.symbol/v0',
    payload: { kind: 'bogus' },
    refusal: /payload for "visual\.symbol\/v0" is invalid/,
  },
  {
    label: 'a field of the wrong type on a document facet',
    target: 'document',
    key: 'visual.tags/v0',
    payload: { keys: 5 },
    refusal: /payload for "visual\.tags\/v0" is invalid: keys/,
  },
]

interface Writer {
  readonly name: string
  readonly target: Target
  /** Attempts the write. A batch writer leads with a VALID op, so a refusal that lands late shows as a stored first op. */
  readonly attempt: (deps: ServerDeps, key: string, payload: unknown) => Promise<unknown>
  /** What the writer's own document holds, as plain data. */
  readonly stored: (fx: Fixture) => Promise<unknown>
}

const storedBoard = async ({ deps }: Fixture) =>
  (await loadDocument(deps, WORKSPACE_ID, CANVAS_ID)).canvas

const storedNote = async ({ deps }: Fixture) => {
  const { doc } = await loadDocument(deps, WORKSPACE_ID, NOTE_ID)
  return { facets: readFacets(doc), core: readCoreFacets(doc) }
}

const FIRST_OK = {
  op: 'node.add',
  node: { type: 'text', text: 'kept only if the batch is', id: 'extra', x: 900, y: 0 },
} as const

const edit = (deps: ServerDeps, ops: readonly unknown[]) =>
  createCanvasEditTool(deps).execute({
    workspaceId: WORKSPACE_ID,
    documentId: CANVAS_ID,
    mode: 'apply',
    ops: ops as never,
  })

const markdownWith = (key: string, payload: unknown) =>
  `---\ntype: note\nfacets:\n  ${key}: ${JSON.stringify(payload)}\n---\nbody`

const WRITERS: readonly Writer[] = [
  {
    name: 'wb_facet_set on a node',
    target: 'node',
    attempt: (deps, key, payload) =>
      createFacetSetTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [CANVAS_ID],
        nodeId: 'a',
        facets: { [key]: payload },
      }),
    stored: storedBoard,
  },
  {
    name: 'wb_canvas_edit node.add',
    target: 'node',
    attempt: (deps, key, payload) =>
      edit(deps, [
        FIRST_OK,
        {
          op: 'node.add',
          node: { type: 'text', text: 'c', id: 'c', x: 0, y: 300, facets: { [key]: payload } },
        },
      ]),
    stored: storedBoard,
  },
  {
    name: 'wb_facet_set on an edge',
    target: 'edge',
    attempt: (deps, key, payload) =>
      createFacetSetTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [CANVAS_ID],
        edgeId: 'e',
        facets: { [key]: payload },
      }),
    stored: storedBoard,
  },
  {
    name: 'wb_canvas_edit edge.add',
    target: 'edge',
    attempt: (deps, key, payload) =>
      edit(deps, [
        FIRST_OK,
        {
          op: 'edge.add',
          edge: { id: 'e2', from: { node: 'a' }, to: { node: 'b' }, facets: { [key]: payload } },
        },
      ]),
    stored: storedBoard,
  },
  {
    name: 'wb_canvas_edit edge.patch',
    target: 'edge',
    attempt: (deps, key, payload) =>
      edit(deps, [FIRST_OK, { op: 'edge.patch', id: 'e', patch: { facets: { [key]: payload } } }]),
    stored: storedBoard,
  },
  {
    name: 'wb_canvas_edit line.add',
    target: 'edge',
    attempt: (deps, key, payload) =>
      edit(deps, [
        FIRST_OK,
        {
          op: 'line.add',
          line: {
            id: 'l2',
            from: { kind: 'point', point: { x: 0, y: 200 } },
            to: { kind: 'point', point: { x: 50, y: 200 } },
            facets: { [key]: payload },
          },
        },
      ]),
    stored: storedBoard,
  },
  {
    name: 'wb_canvas_edit line.patch',
    target: 'edge',
    attempt: (deps, key, payload) =>
      edit(deps, [FIRST_OK, { op: 'line.patch', id: 'l', patch: { facets: { [key]: payload } } }]),
    stored: storedBoard,
  },
  {
    name: 'wb_facet_set on a document',
    target: 'document',
    attempt: (deps, key, payload) =>
      createFacetSetTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [NOTE_ID],
        facets: { [key]: payload },
      }),
    stored: storedNote,
  },
  {
    name: 'wb_document_set frontmatter',
    target: 'document',
    attempt: (deps, key, payload) =>
      createDocumentSetTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: NOTE_ID,
        markdown: markdownWith(key, payload),
      }),
    stored: storedNote,
  },
  {
    name: 'wb_document_create frontmatter',
    target: 'document',
    attempt: (deps, key, payload) =>
      wbDocumentCreate(deps, {
        workspaceId: WORKSPACE_ID,
        path: 'fresh',
        kind: 'markdown',
        markdown: markdownWith(key, payload),
      }),
    // A refused create leaves no document squatting the path.
    stored: async ({ deps, store }) => ({
      note: await storedNote({ deps, store }),
      paths: (await deps.documentIndex.listDocuments({ workspaceId: WORKSPACE_ID }))
        .map((entry) => entry.path)
        .sort(),
    }),
  },
]

const CASES = INVALID_WRITES.flatMap((write) =>
  WRITERS.filter((writer) => writer.target === write.target).map(
    (writer) => [writer.name, write.label, writer, write] as const,
  ),
)

describe('a registered facet write is refused by every writer, and nothing is stored', () => {
  test('the table reaches every writer and every kind of write', () => {
    expect(new Set(CASES.map(([name]) => name)).size).toBe(WRITERS.length)
    expect(new Set(CASES.map(([, , , write]) => write.key)).size).toBeGreaterThanOrEqual(6)
    expect(CASES.length).toBeGreaterThan(25)
  })

  test.each(CASES)('%s refuses %s', async (_writer, _write, writer, write) => {
    const fx = await fixture()
    const before = await writer.stored(fx)

    await expect(writer.attempt(fx.deps, write.key, write.payload)).rejects.toThrow(write.refusal)

    expect(await writer.stored(fx)).toEqual(before)
  })

  test('a canvas-edit refusal names the facet and the op that carried it', async () => {
    const fx = await fixture()
    await expect(
      edit(fx.deps, [
        FIRST_OK,
        {
          op: 'edge.patch',
          id: 'e',
          patch: { facets: { 'visual.edges/v0': { routing: 'zigzag' } } },
        },
      ]),
    ).rejects.toThrow(/ops\[1\] \(edge\.patch\).*facet "visual\.edges\/v0" rejected/)
  })

  test('a valid registered write is still applied through every writer', async () => {
    const fx = await fixture()
    await edit(fx.deps, [
      {
        op: 'node.add',
        node: {
          type: 'text',
          text: 'c',
          id: 'c',
          x: 0,
          y: 300,
          facets: { 'visual.shape/v0': { kind: 'ellipse' } },
        },
      },
      {
        op: 'edge.patch',
        id: 'e',
        patch: { facets: { 'visual.edges/v0': { routing: 'curved' } } },
      },
    ])
    const canvas = readSpatialCanvas((await loadDocument(fx.deps, WORKSPACE_ID, CANVAS_ID)).doc)
    expect(canvas.nodes.find((node) => node.id === 'c')?.facets).toEqual({
      'visual.shape/v0': { kind: 'ellipse' },
    })
    expect(canvas.edges.find((edge) => edge.id === 'e')?.facets).toEqual({
      'visual.edges/v0': { routing: 'curved' },
    })
  })
})

/**
 * A lock is a person's promise that an agent will not change an element, and a
 * facet or a tag is a change. Every way `wb_facet_set` reaches a locked node
 * or edge is a row; the sentence is `wb_canvas_edit`'s, since the way out is
 * the same.
 */
type FacetSetInput = Parameters<ReturnType<typeof createFacetSetTool>['execute']>[0]

describe('wb_facet_set refuses a locked node or edge, and writes nothing', () => {
  const TAGGED: SpatialCanvas = {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 80, height: 40, text: 'A', tags: ['old'] }),
      textNode({
        id: 'b',
        x: 300,
        y: 0,
        width: 80,
        height: 40,
        text: 'B',
        tags: ['old', 'only-b'],
      }),
    ],
    edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, tags: ['old'] }],
  }

  async function lockedFixture(): Promise<Fixture> {
    const store = new FakeDocumentStore()
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, TAGGED)
      setNodeLock(doc, 'a', true)
      setEdgeLock(doc, 'e', true)
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID, 'board')
    return {
      store,
      deps: makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    }
  }

  const set = (fx: Fixture, input: Omit<FacetSetInput, 'workspaceId' | 'documentIds'>) =>
    createFacetSetTool(fx.deps).execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [CANVAS_ID],
      ...input,
    })

  const NODE_LOCKED = /node "a" is locked; unlock it with a node\.lock op first/
  const EDGE_LOCKED = /edge "e" is locked; unlock it with an edge\.lock op first/

  const LOCKED_WRITES: readonly (readonly [
    string,
    Omit<FacetSetInput, 'workspaceId' | 'documentIds'>,
    RegExp,
  ])[] = [
    [
      'facets on the node',
      { nodeId: 'a', facets: { 'visual.shape/v0': { kind: 'ellipse' } } },
      NODE_LOCKED,
    ],
    [
      'a facet deleted from the node',
      { nodeId: 'a', facets: { 'visual.shape/v0': null } },
      NODE_LOCKED,
    ],
    ['tags added to the node', { nodeId: 'a', tags: { add: ['t'] } }, NODE_LOCKED],
    ['tags removed from the node', { nodeId: 'a', tags: { remove: ['old'] } }, NODE_LOCKED],
    [
      'a rename scoped to the node',
      { nodeId: 'a', tags: { rename: [{ from: 'old', to: 'new' }] } },
      NODE_LOCKED,
    ],
    [
      'facets on the edge',
      { edgeId: 'e', facets: { 'visual.edges/v0': { routing: 'curved' } } },
      EDGE_LOCKED,
    ],
    ['tags added to the edge', { edgeId: 'e', tags: { add: ['t'] } }, EDGE_LOCKED],
    [
      'a rename scoped to the edge',
      { edgeId: 'e', tags: { rename: [{ from: 'old', to: 'new' }] } },
      EDGE_LOCKED,
    ],
    [
      'a board-wide rename that reaches the locked node',
      { tags: { rename: [{ from: 'old', to: 'new' }] } },
      NODE_LOCKED,
    ],
    [
      'a board-wide rename addressed to the canvas',
      { target: 'canvas', tags: { rename: [{ from: 'old', to: 'new' }] } },
      NODE_LOCKED,
    ],
  ]

  test('the table covers facets and tags on both element kinds and the board-wide rename', () => {
    expect(LOCKED_WRITES.length).toBeGreaterThanOrEqual(10)
    expect(new Set(LOCKED_WRITES.map(([, , refusal]) => refusal)).size).toBe(2)
  })

  test.each(LOCKED_WRITES)('%s', async (_label, input, refusal) => {
    const fx = await lockedFixture()
    const before = await storedBoard(fx)

    await expect(set(fx, input)).rejects.toThrow(refusal)
    await expect(set(fx, input)).rejects.toMatchObject({ name: 'ElementLockedError' })

    expect(await storedBoard(fx)).toEqual(before)
  })

  // `.some` over the element's tags, not `.every`: an element carrying one
  // renamed tag and one untouched tag is still rewritten by the rename.
  test.each([
    'node',
    'edge',
  ] as const)('a board-wide rename refuses a locked %s that carries a tag the rename leaves alone', async (lock) => {
    const store = new FakeDocumentStore()
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [
          textNode({
            id: 'a',
            x: 0,
            y: 0,
            width: 80,
            height: 40,
            text: 'A',
            tags: ['old', 'keep'],
          }),
          textNode({ id: 'b', x: 300, y: 0, width: 80, height: 40, text: 'B', tags: ['keep'] }),
        ],
        edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, tags: ['old', 'keep'] }],
      })
      if (lock === 'node') setNodeLock(doc, 'a', true)
      else setEdgeLock(doc, 'e', true)
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, CANVAS_ID, 'board')
    const fx = {
      store,
      deps: makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    }
    const before = await storedBoard(fx)

    await expect(set(fx, { tags: { rename: [{ from: 'old', to: 'new' }] } })).rejects.toMatchObject(
      { name: 'ElementLockedError' },
    )

    expect(await storedBoard(fx)).toEqual(before)
  })

  test('a board-wide rename that reaches only unlocked elements still applies', async () => {
    const fx = await lockedFixture()

    await set(fx, { tags: { rename: [{ from: 'only-b', to: 'renamed' }] } })

    const canvas = await storedBoard(fx)
    expect(canvas.nodes.find((node) => node.id === 'b')?.tags).toEqual(['old', 'renamed'])
    expect(canvas.nodes.find((node) => node.id === 'a')?.tags).toEqual(['old'])
  })

  test('an unlocked sibling of a locked node takes facets and tags', async () => {
    const fx = await lockedFixture()

    await set(fx, {
      nodeId: 'b',
      facets: { 'visual.shape/v0': { kind: 'ellipse' } },
      tags: { add: ['t'] },
    })

    const node = (await storedBoard(fx)).nodes.find((candidate) => candidate.id === 'b')
    expect(node?.facets).toEqual({ 'visual.shape/v0': { kind: 'ellipse' } })
    expect(node?.tags).toContain('t')
  })
})

describe('what an op stores of a facets bucket it carries', () => {
  const stored = async (fx: Fixture) =>
    readSpatialCanvas((await loadDocument(fx.deps, WORKSPACE_ID, CANVAS_ID)).doc)
  const nodeC = (facets: unknown) => ({
    op: 'node.add',
    node: { type: 'text', text: 'c', id: 'c', x: 0, y: 300, facets },
  })

  test('a deletion tombstone beside a valid payload is not stored', async () => {
    const fx = await fixture()
    await edit(fx.deps, [
      nodeC({ 'visual.shape/v0': { kind: 'ellipse' }, 'visual.stencil/v0': null }),
    ])
    expect((await stored(fx)).nodes.find((n) => n.id === 'c')?.facets).toEqual({
      'visual.shape/v0': { kind: 'ellipse' },
    })
  })

  test('a bucket of tombstones alone stores no bucket at all', async () => {
    const fx = await fixture()
    await edit(fx.deps, [nodeC({ 'visual.shape/v0': null })])
    const node = (await stored(fx)).nodes.find((n) => n.id === 'c')
    expect(node).toBeDefined()
    expect('facets' in (node as object)).toBe(false)
  })

  test('edge.add and line.add store a valid bucket', async () => {
    const fx = await fixture()
    await edit(fx.deps, [
      {
        op: 'edge.add',
        edge: {
          id: 'e2',
          from: { node: 'a' },
          to: { node: 'b' },
          facets: { 'visual.edges/v0': { routing: 'curved' } },
        },
      },
      {
        op: 'line.add',
        line: {
          id: 'l2',
          from: { kind: 'point', point: { x: 0, y: 200 } },
          to: { kind: 'point', point: { x: 50, y: 200 } },
          facets: { 'visual.ink/v0': { group: 'g' } },
        },
      },
    ])
    const canvas = await stored(fx)
    expect(canvas.edges.find((e) => e.id === 'e2')?.facets).toEqual({
      'visual.edges/v0': { routing: 'curved' },
    })
    expect(canvas.lines?.find((l) => l.id === 'l2')?.facets).toEqual({
      'visual.ink/v0': { group: 'g' },
    })
  })

  test('a patch that carries no facets leaves the stored bucket alone', async () => {
    const fx = await fixture()
    await edit(fx.deps, [
      {
        op: 'edge.patch',
        id: 'e',
        patch: { facets: { 'visual.edges/v0': { routing: 'curved' } } },
      },
    ])
    await edit(fx.deps, [{ op: 'edge.patch', id: 'e', patch: { label: 'renamed' } }])
    const edge = (await stored(fx)).edges.find((e) => e.id === 'e')
    expect(edge?.label).toBe('renamed')
    expect(edge?.facets).toEqual({ 'visual.edges/v0': { routing: 'curved' } })
  })

  test('a patch whose bucket is all tombstones clears the stored bucket', async () => {
    const fx = await fixture()
    await edit(fx.deps, [
      {
        op: 'edge.patch',
        id: 'e',
        patch: { facets: { 'visual.edges/v0': { routing: 'curved' } } },
      },
    ])
    await edit(fx.deps, [
      { op: 'edge.patch', id: 'e', patch: { facets: { 'visual.edges/v0': null } } },
    ])
    expect((await stored(fx)).edges.find((e) => e.id === 'e')?.facets).toBeUndefined()
  })
})
