import { writeFacets, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { SnapshotNotFoundError } from './document-io.js'
import { exportOkf } from './export-okf.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore): ServerDeps {
  return makeTestDeps({
    documentStore: documentStore,
    documentIndex: documentStore.documentIndex,
  })
}

describe('exportOkf', () => {
  test('exports the first text node body with facets from the doc', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 50, text: 'hello' })],
        edges: [],
      })
      writeFacets(doc, { 'example.kanban/v1': { status: 'todo' } })
    })
    const result = await exportOkf(makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
    })

    expect(result.markdown.startsWith('---\n')).toBe(true)
    expect(result.markdown).toContain('hello')
    expect(result.frontmatter.facets).toEqual({ 'example.kanban/v1': { status: 'todo' } })
  })

  test('falls back to an empty body when the canvas has no text node', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [groupNode({ id: 'n1', x: 0, y: 0, width: 100, height: 50 })],
        edges: [],
      })
    })
    const result = await exportOkf(makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
    })

    expect(result.markdown.endsWith('---\n')).toBe(true)
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    await expect(
      exportOkf(makeDeps(new FakeDocumentStore()), {
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
      }),
    ).rejects.toThrow(SnapshotNotFoundError)
  })

  // The serialization and the body are two different answers, and a caller
  // that wants to DRAW the document wants the second one. Handing over only
  // `markdown` made every such caller either re-parse what this function
  // already had in hand, or — which is what happened — draw the frontmatter
  // block as prose.
  test('answers the body on its own, beside the serialization that embeds it', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 50, text: '# Title' })],
        edges: [],
      })
    })
    const result = await exportOkf(makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
    })

    expect(result.body).toBe('# Title')
    expect(result.markdown).toContain(result.body)
    expect(result.markdown.startsWith('---\n')).toBe(true)
  })
})
