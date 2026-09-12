// `stencil` on node.add and node.patch (ADR-0034): the one op-surface half
// of the stencil increment. A caller names a KIND and the tool dresses the
// box — one field where the alternative is a colour, a silhouette and a
// badge written by hand, per box, in a vocabulary invented per board.

import {
  createFacetRegistry,
  definePlugin,
  type FacetRegistry,
} from '@kamiazya/whiteboard-facet-engine'
import {
  writeDocumentKind,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  resolveNodeShape,
  resolveNodeStencil,
  visualPlugin,
} from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { canvasEditInputSchema, createCanvasEditTool } from './canvas-edit.js'
import { loadDocument } from './document-io.js'
import { STENCIL_LIBRARY_PATH } from './stencil-library.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

/**
 * Runs the batch and answers what was STORED, not what the tool reported:
 * the facets a stencil writes have to survive the save, and the snapshot in
 * the reply is a summary that would not show it either way.
 */
const run = async (ops: unknown[], facetRegistry?: FacetRegistry) => {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, { nodes: [], edges: [] })
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const deps = makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    ...(facetRegistry === undefined ? {} : { facetRegistry }),
  })
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

describe('a deployment\u2019s own stencils', () => {
  // ADR-0034 decision 4's whole point: a vocabulary this repo did not ship.
  // `deps.facetRegistry` is the seam a composition root overrides, and
  // `facet-set`/`facet-list` already read it — the stencil path did not, so
  // a deployment could register a stencil that `wb_facet_list` reported and
  // `wb_canvas_edit` refused.
  const infra = definePlugin({
    id: 'infra',
    displayName: 'Infra',
    facets: [],
    assets: {
      stencils: {
        bucket: {
          displayName: 'Bucket',
          color: '2',
          facets: { 'visual.shape/v0': { kind: 'cylinder' } },
        },
      },
    },
  })

  test('applies a stencil only the deployment registered', async () => {
    const registry = createFacetRegistry([visualPlugin, infra])
    const { canvas } = await run(
      [
        {
          op: 'node.add',
          node: { id: 'b', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'assets' },
          stencil: 'infra.bucket',
        },
      ],
      registry,
    )
    const node = canvas.nodes.find((n) => n.id === 'b')
    expect(resolveNodeStencil(node as never, registry)).toBe('infra.bucket')
    expect(node?.color).toBe('2')
  })

  test('lists the deployment\u2019s stencils when refusing an unknown one', async () => {
    // The refusal names what IS registered, so a caller learns the
    // vocabulary from the error. Reading the bundled list here would teach
    // a deployment's caller the wrong set.
    await expect(
      run(
        [
          {
            op: 'node.add',
            node: { id: 'x', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'X' },
            stencil: 'infra.nope',
          },
        ],
        createFacetRegistry([visualPlugin, infra]),
      ),
    ).rejects.toThrow(/infra\.bucket/)
  })
})

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

  test('tells a caller who put stencil inside node.add\u2019s node where it belongs', async () => {
    // The sibling of the case above, and the one that was SILENT. `patch` is
    // `.strict()` so a stray key is refused there; a node DRAFT strips, so
    // `stencil` inside `node` was accepted, dropped, and the box drawn
    // undressed with nothing said. Measured in the lane that took this
    // increment's reading: a trial put it there, got no error, noticed from
    // the render that nothing was dressed, and spent seventeen further calls
    // rebuilding the vocabulary by hand — ending one channel apart instead
    // of two. Inside `node` is also the likelier guess, because every other
    // property of the box goes there.
    await expect(
      run([
        {
          op: 'node.add',
          node: {
            id: 'a',
            type: 'text',
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            text: 'A',
            stencil: 'visual.service',
          },
        },
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
    expect(resolveNodeShape(node as never)).toBe('cylinder')
    // And NO colour: the bundled vocabulary spends silhouette alone, so the
    // colour channel is free for whatever second axis the drawing declares
    // (ADR-0036 §5).
    expect(node?.color).toBeUndefined()
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
      expect(resolveNodeShape(node as never)).toBe('octagon')
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

  test('re-dressing a box takes the NEW silhouette and keeps the colour the caller set', async () => {
    // The colour here is the drawing's SECOND axis — health, say — and it
    // belongs to nobody else. Changing what a box IS must not overwrite what
    // the drawing says about how it is doing (ADR-0036 §5).
    const { canvas } = await run([
      {
        op: 'node.add',
        node: { id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'A', color: '1' },
      },
      { op: 'node.patch', id: 'a', patch: {}, stencil: 'visual.datastore' },
      { op: 'node.patch', id: 'a', patch: {}, stencil: 'visual.queue' },
    ])
    const node = canvas.nodes.find((n) => n.id === 'a')
    expect(node?.color).toBe('1')
    expect(resolveNodeShape(node as never)).toBe('parallelogram')
    expect(resolveNodeStencil(node as never)).toBe('visual.queue')
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

describe('a workspace\u2019s own stencil library', () => {
  // ADR-0034 decision 4: a library is CONTENT — a document in the workspace,
  // not a deployment's plugin set. This is the end of that path: a stencil
  // nobody shipped, authored as a document, dressing a box.
  const LIBRARY_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'

  const runWithLibrary = async (facets: Record<string, unknown> | undefined, ops: unknown[]) => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, { nodes: [], edges: [] })
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    if (facets !== undefined) {
      await seedDoc(store, LIBRARY_ID, (doc) => {
        writeDocumentKind(doc, 'markdown')
        writeFacets(doc, facets as never)
      })
      store.documentIndex.seed({
        workspaceId: WORKSPACE_ID,
        documentId: LIBRARY_ID,
        path: STENCIL_LIBRARY_PATH,
        kind: 'markdown',
      })
    }
    const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
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

  const addWearing = (stencil: string) => [
    {
      op: 'node.add',
      node: { id: 'b', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'orders' },
      stencil,
    },
  ]

  test('dresses a box with a stencil the LIBRARY defines and no plugin shipped', async () => {
    const { canvas } = await runWithLibrary(
      {
        'visual.stencils/v0': {
          stencils: {
            bucket: {
              displayName: 'Bucket',
              color: '2',
              facets: { 'visual.shape/v0': { kind: 'cylinder' } },
            },
          },
        },
      },
      addWearing('workspace.bucket'),
    )

    const node = canvas.nodes.find((n) => n.id === 'b')
    expect(node?.color).toBe('2')
    expect(resolveNodeShape(node as never)).toBe('cylinder')
    // Recorded under the same key a bundled stencil records under, so the
    // facet axis reads a library-dressed board exactly as it reads any
    // other. Asserted on the STORED payload rather than through a resolver:
    // a resolver takes a registry, and the question here is what the
    // document now says, not what some registry can make of it.
    expect(
      (node as { 'x-whiteboard'?: { facets?: Record<string, unknown> } })['x-whiteboard']?.facets?.[
        'visual.stencil/v0'
      ],
    ).toEqual({ stencil: 'workspace.bucket' })
  })

  test('re-dressing takes the NEW stencil\u2019s colour, not the one it already had', async () => {
    // Found by re-reading the diff. `dressWithStencil` decided "the caller
    // was explicit" by looking at `node.color` — which on a patch is always
    // set, from an earlier stencil or an earlier edit. So every re-dress
    // took the new silhouette and badge and kept the OLD colour: a box
    // belonging to neither construct, which is ADR-0033's `excess` shape.
    //
    // It lives HERE, on library stencils, because the bundled set spends no
    // colour any more (ADR-0036 §5) and so cannot exercise the rule. A
    // vocabulary somebody else authors still may, and this is the guard that
    // keeps `requestedColor` a parameter rather than a read off the node.
    const library = {
      'visual.stencils/v0': {
        stencils: {
          cold: { displayName: 'Cold', color: '5' },
          hot: { displayName: 'Hot', color: '6' },
        },
      },
    }
    const { canvas } = await runWithLibrary(library, [
      ...addWearing('workspace.cold'),
      { op: 'node.patch', id: 'b', patch: {}, stencil: 'workspace.hot' },
    ])
    const node = canvas.nodes.find((n) => n.id === 'b')
    expect(node?.color).toBe('6')
    expect(resolveNodeStencil(node as never)).toBe('workspace.hot')
  })

  test('refuses a library id in a workspace that has no library, listing what it does have', async () => {
    await expect(runWithLibrary(undefined, addWearing('workspace.bucket'))).rejects.toThrow(
      /visual\.datastore/,
    )
  })

  test('reads no library at all for a batch that names no stencil', async () => {
    // The cost decision, pinned rather than trusted: finding a library is a
    // listing plus a read, and `wb_canvas_edit` is the hottest write tool
    // there is. A batch that moves boxes must not pay for a vocabulary it
    // does not mention.
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, { nodes: [], edges: [] })
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    // Counted on this test's OWN store, which is built here and discarded
    // here — nothing to restore, and nothing another test can observe.
    let listings = 0
    const listDocuments = store.documentIndex.listDocuments.bind(store.documentIndex)
    store.documentIndex.listDocuments = (arg) => {
      listings += 1
      return listDocuments(arg)
    }
    const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
    const input = canvasEditInputSchema.parse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: { id: 'p', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'plain' },
        },
      ],
    })
    await createCanvasEditTool(deps).execute(input as never)

    expect(listings).toBe(0)
  })

  test('leaves the bundled vocabulary working beside it', async () => {
    const { canvas } = await runWithLibrary(
      { 'visual.stencils/v0': { stencils: { bucket: { displayName: 'Bucket' } } } },
      addWearing('visual.datastore'),
    )
    expect(resolveNodeShape(canvas.nodes.find((n) => n.id === 'b') as never)).toBe('cylinder')
  })
})
