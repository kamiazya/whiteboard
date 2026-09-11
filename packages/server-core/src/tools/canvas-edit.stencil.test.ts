// `stencil` on node.add and node.patch (ADR-0034): the one op-surface half
// of the stencil increment. A caller names a KIND and the tool dresses the
// box — one field where the alternative is a colour, a silhouette and a
// badge written by hand, per box, in a vocabulary invented per board.
import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { resolveNodeShape, resolveNodeStencil } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { canvasEditInputSchema, createCanvasEditTool } from './canvas-edit.js'
import { loadDocument } from './document-io.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

/**
 * Runs the batch and answers what was STORED, not what the tool reported:
 * the facets a stencil writes have to survive the save, and the snapshot in
 * the reply is a summary that would not show it either way.
 */
const run = async (ops: unknown[]) => {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, { nodes: [], edges: [] })
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
  // PARSED first, deliberately: `execute` does not validate its own input —
  // the MCP layer does — so a test calling it directly exercises a path no
  // caller has. A redirect written for a key zod refuses at parse reads as
  // working from inside `execute` and never fires in production; one here
  // did, until this line was added.
  const input = canvasEditInputSchema.parse({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode: 'apply',
    ops,
  })
  const result = await createCanvasEditTool(deps).execute(input as never)
  const { canvas } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
  return { result, canvas }
}

describe('dressing a box with a stencil', () => {
  test('tells a caller who put stencil inside patch where it belongs', async () => {
    // The same class as the measured `id`-beside-`op` case this tool already
    // redirects: `stencil` is an instruction to expand a vocabulary, not a
    // field of the stored node, so it sits at the op level like `within`. A
    // model that guesses wrong loses the WHOLE batch, and the generic
    // dropped-key refusal names the key without naming the repair.
    await expect(
      run([
        {
          op: 'node.add',
          node: { id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'A' },
        },
        { op: 'node.patch', id: 'a', patch: { stencil: 'visual.service' } },
      ]),
    ).rejects.toThrow(/`stencil` goes beside `op`/)
  })

  test('node.add applies the appearance and records the kind in one field', async () => {
    const { result, canvas } = await run([
      {
        op: 'node.add',
        node: { id: 'db', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'orders' },
        stencil: 'visual.datastore',
      },
    ])
    expect(result.applied).toBe(1)
    const node = canvas.nodes.find((n) => n.id === 'db')
    expect(node).toBeDefined()
    expect(node?.color).toBe('5')
    expect(resolveNodeShape(node as never)).toBe('cylinder')
    expect(resolveNodeStencil(node as never)).toBe('visual.datastore')
    // The text the caller wrote is untouched: a stencil says what a box IS,
    // never what it says.
    expect((node as { text?: string }).text).toBe('orders')
  })

  test('node.patch dresses boxes that already exist, and takes a selector', async () => {
    const { canvas } = await run([
      {
        op: 'node.add',
        node: { id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'A' },
      },
      {
        op: 'node.add',
        node: { id: 'b', type: 'text', x: 300, y: 0, width: 200, height: 80, text: 'B' },
      },
      { op: 'node.patch', all: true, patch: {}, stencil: 'visual.service' },
    ])
    for (const id of ['a', 'b']) {
      const node = canvas.nodes.find((n) => n.id === id)
      expect(resolveNodeStencil(node as never)).toBe('visual.service')
      expect(node?.color).toBe('4')
    }
  })

  test('refuses a stencil nobody registered, and names the ones that are', async () => {
    // The whole batch is refused rather than the box landing undressed: a
    // caller that cannot tell whether the vocabulary was applied ships a
    // drawing claiming a distinction it does not draw.
    await expect(
      run([
        {
          op: 'node.add',
          node: { id: 'x', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'X' },
          stencil: 'visual.nope',
        },
      ]),
    ).rejects.toThrow(/visual\.datastore/)
  })

  test('an explicit colour beside a stencil wins, so a caller can still say something else', async () => {
    const { canvas } = await run([
      {
        op: 'node.add',
        node: { id: 'q', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'Q', color: '1' },
        stencil: 'visual.queue',
      },
    ])
    const node = canvas.nodes.find((n) => n.id === 'q')
    expect(node?.color).toBe('1')
    // ...and the rest of the stencil still applies, including the record.
    expect(resolveNodeShape(node as never)).toBe('parallelogram')
    expect(resolveNodeStencil(node as never)).toBe('visual.queue')
  })
})
