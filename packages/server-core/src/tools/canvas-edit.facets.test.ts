// `facets` on node.add and node.patch, at OP level beside `stencil`: the
// write path for the SECOND axis. Measured reason (ADR-0031 §17-21): asked to
// tell kind and health apart at once, a model dressed the kind inline with
// `stencil` every trial and wrote the health as a bare `color` every trial —
// because the only route to a health FACET was one `wb_facet_set` per box
// plus a canvas declaration, against one word inline for the kind. Nine
// trials, zero node facets. This makes the two axes cost the same.
//
// Op level and not inside `node`, priced rather than reasoned: a field inside
// the node draft is emitted once per arm of the type union (+1,020 visible
// bytes for one described field); a field beside `op` is emitted once.

import {
  createFacetRegistry,
  defineFacet,
  definePlugin,
  type FacetRegistry,
} from '@kamiazya/whiteboard-facet-engine'
import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { bundledPlugins, SEMANTIC_CLASS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
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

/** Same harness as the stencil tests: parsed first, and what was STORED is read back. */
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

const box = (id: string) => textNode({ id, x: 0, y: 0, width: 200, height: 80, text: id })
const health = (value: string) => ({ [SEMANTIC_CLASS_KEY]: { axis: 'health', value } })

describe('facets on node.add', () => {
  test('lands the classification on the stored node, beside what the stencil wrote', async () => {
    const { result, canvas } = await run([
      { op: 'node.add', node: box('db'), stencil: 'visual.datastore', facets: health('failing') },
    ])
    expect(result.applied).toBe(1)
    const facets = canvas.nodes[0]?.facets ?? {}
    expect(facets[SEMANTIC_CLASS_KEY]).toEqual({ axis: 'health', value: 'failing' })
    // The stencil's own facets survive: one field does not clobber the other.
    expect(facets['visual.stencil/v0']).toEqual({ stencil: 'visual.datastore' })
  })

  test('refuses a facet whose declared targets do not include a node, naming both', async () => {
    await expect(
      run([
        { op: 'node.add', node: box('a'), facets: { 'visual.theme/v0': { theme: 'visual.neon' } } },
      ]),
    ).rejects.toThrow(/visual\.theme\/v0.*targets are \[canvas\].*node/)
  })

  test('refuses a payload the facet’s own schema refuses, with that schema’s reason', async () => {
    await expect(
      run([
        {
          op: 'node.add',
          node: box('a'),
          facets: { [SEMANTIC_CLASS_KEY]: { axis: 'Health', value: 'ok' } },
        },
      ]),
    ).rejects.toThrow(/semantic\.class\/v0.*lowercase identifier/)
  })

  test('tells a caller who put facets INSIDE node where it belongs', async () => {
    // The same silence `stencil` inside `node` had, and the same repair: a
    // node draft is strict, so the key is refused, and the refusal says
    // where the key goes rather than only that it is unrecognised.
    await expect(
      run([{ op: 'node.add', node: { ...box('a'), facets: health('ok') } }]),
    ).rejects.toThrow(/`facets` goes beside `op`/)
  })

  test('passes an UNREGISTERED key through unvalidated, as wb_facet_set does', async () => {
    // Round-trip safety: a payload written by a plugin this deployment does
    // not have must survive a re-write here. What #81 found writable through
    // wb_facet_set stays writable through the inline path.
    const { canvas } = await run([
      { op: 'node.add', node: box('a'), facets: { 'ops.status/v0': { status: 'x' } } },
    ])
    expect(canvas.nodes[0]?.facets?.['ops.status/v0']).toEqual({ status: 'x' })
  })
})

describe('facets on node.patch', () => {
  test('merges by key: an omitted key keeps its value, null deletes it', async () => {
    const { canvas } = await run([
      {
        op: 'node.add',
        node: box('a'),
        facets: { ...health('ok'), 'ops.status/v0': { status: 'x' } },
      },
      {
        op: 'node.patch',
        id: 'a',
        patch: {},
        facets: { ...health('failing'), 'ops.status/v0': null },
      },
    ])
    const facets = canvas.nodes[0]?.facets ?? {}
    expect(facets[SEMANTIC_CLASS_KEY]).toEqual({ axis: 'health', value: 'failing' })
    expect(facets).not.toHaveProperty('ops.status/v0')
  })

  test('applies to every node a selection names', async () => {
    const { canvas } = await run([
      { op: 'node.add', node: box('a') },
      { op: 'node.add', node: { ...box('b'), x: 300 } },
      { op: 'node.patch', all: true, patch: {}, facets: health('ok') },
    ])
    for (const node of canvas.nodes) {
      expect(node.facets?.[SEMANTIC_CLASS_KEY]).toEqual({ axis: 'health', value: 'ok' })
    }
  })
})

describe('a deployment’s own node facet', () => {
  // The registry seam, as the stencil path already honours it: a facet this
  // repo did not ship, registered by a deployment, is writable inline.
  const ops = definePlugin({
    id: 'ops',
    displayName: 'Ops',
    facets: [
      defineFacet({
        name: 'owner',
        displayName: 'Owner',
        version: 'v0',
        targets: ['node'],
        schema: z.object({ team: z.string() }).strict(),
      }),
    ],
  })
  const registry = createFacetRegistry([...bundledPlugins, ops])

  test('is validated against its registered schema, not passed through', async () => {
    await expect(
      run([{ op: 'node.add', node: box('a'), facets: { 'ops.owner/v0': { team: 42 } } }], registry),
    ).rejects.toThrow(/ops\.owner\/v0/)
  })
})
