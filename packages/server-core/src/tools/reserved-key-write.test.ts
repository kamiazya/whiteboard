// A value holding an own `__proto__` key — what `JSON.parse` and the YAML
// parser hand a tool — is stored by a Loro map and comes back from every
// projection with its prototype replaced: the shape the sync judge refuses as
// `reserved_map_key`. Every agent write path refuses it before anything is
// stored, whichever tool carried it.

import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { canvasEditInputSchema, createCanvasEditTool } from './canvas-edit.js'
import { createDocumentSetOperation } from './document-set.js'
import { createFacetSetTool } from './facet-set.js'
import { facetSetInputSchema } from './facet-set.schemas.js'

const WORKSPACE_ID = 'ws-reserved'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
/** An unregistered facet, whose payload no registry schema reaches. */
const FACETS_JSON = '{"acme.x/v0":{"__proto__":{"k":1}}}'

async function seeded(kind: 'markdown' | 'spatial') {
  const store = new FakeDocumentStore()
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, kind)
    if (kind === 'spatial') writeSpatialCanvas(doc, { nodes: [], edges: [] })
  })
  const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
  return { store, deps }
}

/** The stored document as JSON, so "unchanged" is asked of what was kept. */
async function stored(store: FakeDocumentStore): Promise<string> {
  const snap = await store.loadSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
  })
  if (!snap) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(snap.manifest, snap.chunks))
  return JSON.stringify(doc.toJSON())
}

describe('an agent write carrying a key named __proto__', () => {
  it('is refused by document.set when the frontmatter nests one, leaving the document as it was', async () => {
    const { store, deps } = await seeded('markdown')
    const tool = createDocumentSetOperation(deps)
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: '---\ntype: note\nkept: 1\n---\noriginal body',
    })
    const before = await stored(store)

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        markdown: '---\ntype: note\nx:\n  __proto__:\n    a: 1\n---\nnew body',
      }),
    ).rejects.toThrow(/"__proto__"/)
    expect(await stored(store)).toBe(before)
  })

  it('is refused by wb_facet_set for an unregistered facet payload, leaving the document as it was', async () => {
    const { store, deps } = await seeded('markdown')
    const before = await stored(store)
    const input = facetSetInputSchema.parse({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: JSON.parse(FACETS_JSON),
    })

    const attempt = createFacetSetTool(deps).execute(input)
    await expect(attempt).rejects.toMatchObject({ code: 'reserved_map_key' })
    await expect(attempt).rejects.toThrow(/"__proto__".*facet "acme\.x\/v0"/)
    expect(await stored(store)).toBe(before)
  })

  it('is refused by wb_canvas_edit node.add, naming the op, with nothing written', async () => {
    const { store, deps } = await seeded('spatial')
    const before = await stored(store)
    const input = canvasEditInputSchema.parse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { type: 'text', text: 'kept?' } },
        { op: 'node.add', node: { type: 'text', text: 'x', facets: JSON.parse(FACETS_JSON) } },
      ],
    })

    await expect(createCanvasEditTool(deps).execute(input as never)).rejects.toThrow(
      /ops\[1\] \(node\.add\).*"__proto__"/s,
    )
    expect(await stored(store)).toBe(before)
  })
})
