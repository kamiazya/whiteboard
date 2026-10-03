// `node.add` carries each kind's own fields into the stored node, and the op
// batch has a fixed ceiling.

import { describe, expect, test } from 'vitest'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, EMPTY, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { canvasEditInputSchema, createCanvasEditTool } from './canvas-edit.js'
import { loadDocument } from './document-io.js'

async function addNode(node: Record<string, unknown>) {
  const store = new FakeDocumentStore()
  await seedCanvas(store, EMPTY)
  const deps = makeDeps(store)
  await createCanvasEditTool(deps).execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode: 'apply',
    ops: [{ op: 'node.add', node: { id: 'added', x: 0, y: 0, width: 300, height: 200, ...node } }],
  } as never)
  const { canvas } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
  return canvas.nodes.find((n) => n.id === 'added')
}

describe('wb_canvas_edit — node.add keeps a kind’s own fields', () => {
  test('a file node keeps the subpath it was added with', async () => {
    const node = await addNode({ type: 'file', file: 'a.md', subpath: '#h' })
    expect(node?.resource).toMatchObject({ location: 'a.md', subpath: '#h' })
  })

  test('a file node added without a subpath is stored as a plain reference', async () => {
    const node = await addNode({ type: 'file', file: 'a.md' })
    expect(node?.resource).toMatchObject({ location: 'a.md' })
    expect(node?.resource).not.toHaveProperty('subpath')
  })

  test('a frame keeps its label, background and backgroundStyle', async () => {
    const node = (await addNode({
      type: 'group',
      label: 'Phase 1',
      background: 'bg.png',
      backgroundStyle: 'cover',
    })) as Record<string, unknown> | undefined
    expect(node).toMatchObject({ label: 'Phase 1', background: 'bg.png', backgroundStyle: 'cover' })
  })
})

describe('wb_canvas_edit — the op batch ceiling', () => {
  const batch = (length: number) => ({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    ops: Array.from({ length }, () => ({ op: 'node.remove', id: 'x' })),
  })

  test('accepts a batch of 200 ops', () => {
    expect(canvasEditInputSchema.safeParse(batch(200)).success).toBe(true)
  })

  test('refuses a batch of 201 ops', () => {
    expect(canvasEditInputSchema.safeParse(batch(201)).success).toBe(false)
  })
})
