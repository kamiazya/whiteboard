// `wb_canvas_edit`'s propose mode (ADR-0029 decision 7). The measurement that
// started that ADR was that this half was never wired: an agent could only
// write to the live document, so the flow the branch machinery was built for
// had no first step. These tests are that first step.
import {
  readProposals,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentActivity, ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { loadDocument } from './document-io.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

const BOARD: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'A' },
    { id: 'b', type: 'text', x: 200, y: 0, width: 100, height: 40, text: 'B' },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
}

function makeDeps(store: FakeDocumentStore, over: Partial<ServerDeps> = {}): ServerDeps {
  return makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    ...over,
  })
}

async function seed(store: FakeDocumentStore, canvas: SpatialCanvas): Promise<void> {
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, canvas)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
}

async function storedProposals(deps: ServerDeps) {
  const { doc } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
  return readProposals(doc)
}

describe('wb_canvas_edit in propose mode', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('leaves the board alone and stores what it would have done', async () => {
    const store = new FakeDocumentStore()
    await seed(store, BOARD)
    const deps = makeDeps(store)

    const result = await createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })

    expect(result.applied).toBe(0)
    expect(result.snapshot.nodes.find((node) => node.id === 'a')?.x).toBe(0)
    const [proposal] = await storedProposals(deps)
    expect(proposal?.changes).toEqual([
      {
        id: 'node:a',
        status: 'open',
        op: 'node.patch',
        nodeId: 'a',
        patch: { x: 400 },
        assumed: { x: 0 },
      },
    ])
    expect(result.proposed?.id).toBe(proposal?.id)
  })

  // The whole reason a proposed node is stored resolved: the placement the
  // tool would have chosen is what a reader has to be shown, and an id-less,
  // geometry-less draft has no box to draw.
  test('stores a proposed node with the id and the box it would have been given', async () => {
    const store = new FakeDocumentStore()
    await seed(store, BOARD)
    const deps = makeDeps(store)

    await createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      ops: [{ op: 'node.add', node: { type: 'text', text: 'C' } }],
    })

    const [proposal] = await storedProposals(deps)
    const change = proposal?.changes[0]
    expect(change?.op).toBe('node.add')
    if (change?.op !== 'node.add') throw new Error('expected a node.add')
    expect(change.node.id).toEqual(expect.any(String))
    expect(change.node.width).toBeGreaterThan(0)
    expect(change.node.height).toBeGreaterThan(0)
    // and the board still has two nodes
    const { canvas } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes).toHaveLength(2)
  })

  test('carries the whole element as the prior value of a removal', async () => {
    const store = new FakeDocumentStore()
    await seed(store, BOARD)
    const deps = makeDeps(store)

    await createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      ops: [{ op: 'edge.remove', id: 'e' }],
    })

    const [proposal] = await storedProposals(deps)
    expect(proposal?.changes).toEqual([
      {
        id: 'edge:e',
        status: 'open',
        op: 'edge.remove',
        edgeId: 'e',
        assumed: { id: 'e', fromNode: 'a', toNode: 'b' },
      },
    ])
  })

  // A verb with no anchor (`tidy`) or one that deletes what it was not told
  // about (`region.set`) can be neither drawn as a prior nor adopted in part.
  // Refusing it by name is what keeps that a decision rather than a surprise.
  test('refuses a verb a proposal cannot represent, and names it', async () => {
    const store = new FakeDocumentStore()
    await seed(store, BOARD)
    const deps = makeDeps(store)

    await expect(
      createCanvasEditTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'propose',
        ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }, { op: 'tidy' }],
      }),
    ).rejects.toThrow(/tidy/)
    expect(await storedProposals(deps)).toEqual([])
  })

  // Decision 8: the batch is one REQUEST, and a request often makes several
  // calls. The caller names the proposal it is still building.
  test('adds to the proposal the caller names instead of opening a second one', async () => {
    const store = new FakeDocumentStore()
    await seed(store, BOARD)
    const deps = makeDeps(store)
    const tool = createCanvasEditTool(deps)

    const first = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      proposalId: first.proposed?.id,
      ops: [{ op: 'node.patch', id: 'b', patch: { y: 300 } }],
    })

    const proposals = await storedProposals(deps)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.changes.map((change) => change.id)).toEqual(['node:a', 'node:b'])
  })

  // `proposed` is typed as a whole proposal, so it has to BE one. Answering
  // with only the call's own delta would make a continuation's result read as
  // a proposal that lost everything proposed before it.
  test('answers a continuation with the whole proposal, not the part it just added', async () => {
    const store = new FakeDocumentStore()
    await seed(store, BOARD)
    const deps = makeDeps(store)
    const tool = createCanvasEditTool(deps)

    const first = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })
    const second = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      proposalId: first.proposed?.id,
      ops: [{ op: 'node.patch', id: 'b', patch: { y: 300 } }],
    })

    expect(second.proposed?.changes.map((change) => change.id)).toEqual(['node:a', 'node:b'])
    expect(second.proposed).toEqual((await storedProposals(deps))[0])
  })

  // A proposal is created once, and `createdAt` says when. A continuation
  // stamping its own time would make the field name a lie — and the whole
  // point of decision 8's batch is that several calls are ONE proposal.
  test('keeps the time the proposal was opened when a later call adds to it', async () => {
    const store = new FakeDocumentStore()
    await seed(store, BOARD)
    const deps = makeDeps(store)
    const tool = createCanvasEditTool(deps)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-06T00:00:00.000Z'))

    const first = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })
    const opened = first.proposed?.createdAt
    // An hour, so a re-stamp is unambiguous. Only `Date` is faked: the store
    // and the tool await ordinary promises, and taking their timers away
    // would make this test about vitest rather than about the clock.
    vi.setSystemTime(new Date('2026-09-06T01:00:00.000Z'))
    const second = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      proposalId: first.proposed?.id,
      ops: [{ op: 'node.patch', id: 'b', patch: { y: 300 } }],
    })

    expect(opened).toBe('2026-09-06T00:00:00.000Z')
    expect(second.proposed?.createdAt).toBe(opened)
  })

  // Nothing changed for a watching browser, so telling it "changed 1" would
  // be a lie. The surface that shows a proposal is a later increment.
  test('does not announce an edit nobody made', async () => {
    const store = new FakeDocumentStore()
    await seed(store, BOARD)
    const activity: AgentActivity[] = []
    const deps = makeDeps(store, {
      clientNotifier: {
        agentActivity: (a: AgentActivity) => {
          activity.push(a)
        },
        requestViewport: async () => false,
        versionCreated: () => {},
        restoreProgress: () => {},
      },
    })

    await createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })

    expect(activity).toEqual([])
  })

  // The default is still apply, and stays so until a person can see and adopt
  // a proposal. ADR-0029 decision 7 wants propose; flipping it before the
  // surface exists would leave this tool unable to change a document at all.
  test('still applies when no mode is named', async () => {
    const store = new FakeDocumentStore()
    await seed(store, BOARD)
    const deps = makeDeps(store)

    const result = await createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })

    expect(result.applied).toBe(1)
    expect(result.proposed).toBeUndefined()
    expect(await storedProposals(deps)).toEqual([])
    const { canvas } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.find((node) => node.id === 'a')?.x).toBe(400)
  })
})
