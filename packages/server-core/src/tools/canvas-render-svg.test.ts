import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, test } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasRenderSvgTool } from './canvas-render-svg.js'
import { SnapshotNotFoundError } from './document-io.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore): ServerDeps {
  return makeTestDeps({
    documentStore: documentStore,
    documentIndex: documentStore.documentIndex,
  })
}

describe('wb_scene_render tool', () => {
  test('renders a seeded canvas to SVG with dimensions', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi' }],
        edges: [],
      })
    })
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
    })

    expect(result.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg">')
    expect(result.svg).toContain('hi')
    // The node's chrome — absent from every MCP-rendered SVG before this
    // migration, since the old builder degraded every node to an empty
    // `<g>` with no visible shape.
    expect(result.svg).toContain('<rect')
    expect(result.width).toBe(100)
    expect(result.height).toBe(50)
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    const tool = createCanvasRenderSvgTool(makeDeps(new FakeDocumentStore()))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        embedReferences: false,
      }),
    ).rejects.toThrow(SnapshotNotFoundError)
  })

  test('renders a markdown document as a page rather than an empty scene', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, '# Real prose')
    })
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
    })

    expect(result.svg).toContain('Real prose')
    expect(result.height).toBeGreaterThan(0)
  })

  test('reads the markdown kind from the index row when the doc bytes carry none (legacy)', async () => {
    // Pins wb_scene_render's OWN wiring of the index-row fallback: a
    // call-site mistake here (swapped ids, wrong workspace) would lay the
    // body out as an EMPTY canvas — no nodes, no text — and stay green
    // under any assertion weaker than the prose being present.
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeMarkdownBody(doc, 'row-kind only')
    })
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      path: 'legacy-md',
      kind: 'markdown',
    })
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
    })

    expect(result.svg).toContain('row-kind only')
  })
})

describe('wb_scene_render measurer injection', () => {
  test('lays the scene out with the measurer the composition root supplied', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 400, height: 200, text: 'hi' }],
        edges: [],
      })
    })
    const measured: string[] = []
    const tool = createCanvasRenderSvgTool({
      ...makeDeps(store),
      measure: async () => (text, font) => {
        measured.push(text)
        // Deliberately unlike the constant-ratio fallback, so a scene laid
        // out with the fallback instead cannot produce this width.
        return { advanceWidth: text.length * font.sizePx * 3, ascent: 1, descent: 1, lineGap: 0 }
      },
    })

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
    })

    expect(measured).toContain('hi')
    expect(result.svg).toContain('hi')
  })
})
