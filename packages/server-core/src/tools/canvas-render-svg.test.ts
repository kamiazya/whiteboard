import {
  constantRatioMeasureText,
  SPATIAL_THEME_FONT_FAMILY,
} from '@kamiazya/whiteboard-canvas-render'
import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { canvasRenderSvgInputSchema, createCanvasRenderSvgTool } from './canvas-render-svg.js'
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
        nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 50, text: 'hi' })],
        edges: [],
      })
    })
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
      style: 'clean',
    })

    // Enveloped: the viewBox is the scene's own bounds, so a consumer that
    // rasterises it gets the whole drawing and not a 0,0-anchored crop.
    expect(result.svg).toMatch(
      /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="100" height="50" viewBox="0 0 100 50"/,
    )
    expect(result.svg).toContain('hi')
    // The node's chrome — absent from every MCP-rendered SVG before this
    // migration, since the old builder degraded every node to an empty
    // `<g>` with no visible shape.
    expect(result.svg).toContain('<rect')
    expect(result.width).toBe(100)
    expect(result.height).toBe(50)
  })

  test('a group label above the frame is inside the envelope, not cropped off the top', async () => {
    // The lane drew an architecture diagram with its first layer at y=0 and
    // the render came back with that layer's label missing: a container's
    // label sits ABOVE its frame, and an SVG with no viewBox is anchored at
    // 0,0, so everything at negative y was clipped. The envelope has to
    // be the scene's bounds, label included.
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [groupNode({ id: 'g', x: 0, y: 0, width: 300, height: 100, label: 'Clients' })],
        edges: [],
      })
    })
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
      style: 'clean',
    })

    const viewBox = /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(result.svg)
    expect(viewBox).not.toBeNull()
    if (viewBox === null) throw new Error('unreachable')
    expect(Number(viewBox[2])).toBeLessThan(0)
    expect(Number(viewBox[4])).toBeGreaterThan(100)
    expect(result.height).toBe(Number(viewBox[4]))
    expect(result.svg).toContain('Clients')
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    const tool = createCanvasRenderSvgTool(makeDeps(new FakeDocumentStore()))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        embedReferences: false,
        style: 'clean',
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
      style: 'clean',
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
      style: 'clean',
    })

    expect(result.svg).toContain('row-kind only')
  })
})

describe('wb_scene_render measurer injection', () => {
  test('lays the scene out with the measurer the composition root supplied', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 400, height: 200, text: 'hi' })],
        edges: [],
      })
    })
    const measured: string[] = []
    const tool = createCanvasRenderSvgTool({
      ...makeDeps(store),
      textMeasurer: async () => ({
        measure: (text, font) => {
          measured.push(text)
          // Deliberately unlike the constant-ratio fallback, so a scene laid
          // out with the fallback instead cannot produce this width.
          return { advanceWidth: text.length * font.sizePx * 3, ascent: 1, descent: 1, lineGap: 0 }
        },
        measurableFamilies: new Set([SPATIAL_THEME_FONT_FAMILY]),
      }),
    })

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
      style: 'clean',
    })

    expect(measured).toContain('hi')
    expect(result.svg).toContain('hi')
  })
})

describe('wb_scene_render style (ADR-0030 decision 6)', () => {
  async function neonStore() {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [
          textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
          textNode({ id: 'b', x: 300, y: 200, width: 100, height: 50, text: 'b' }),
        ],
        edges: [
          {
            id: 'e',
            from: { node: 'a' },
            to: { node: 'b' },
          },
        ],
        facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
      })
    })
    return store
  }

  test('defaults to clean: an agent reading the SVG never pays for a theme unasked', async () => {
    const tool = createCanvasRenderSvgTool(makeDeps(await neonStore()))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
      style: 'clean',
    })
    expect(result.svg).not.toContain('wb-glow')
  })

  test("style: 'document' draws the theme the document names", async () => {
    const tool = createCanvasRenderSvgTool(makeDeps(await neonStore()))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
      style: 'document',
    })
    expect(result.svg).toContain('filterUnits="userSpaceOnUse"')
  })

  test('a theme id draws that theme without the document naming it', async () => {
    const tool = createCanvasRenderSvgTool(makeDeps(await neonStore()))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
      style: 'visual.sketch',
    })
    expect(result.svg).toContain('stroke-linecap="round"')
    expect(result.svg).not.toContain('wb-glow')
  })

  test('the input schema defaults style to clean and refuses a bare name', () => {
    const base = { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }
    expect(canvasRenderSvgInputSchema.parse(base).style).toBe('clean')
    expect(canvasRenderSvgInputSchema.safeParse({ ...base, style: 'sketch' }).success).toBe(false)
  })
})

describe('wb_scene_render declares a theme family only where the measurer holds it', () => {
  // The sketch theme names Yomogi. Whether that family is DECLARED in the SVG
  // is the measurer's answer, never a second list: a family declared from one
  // list and measured from another moves every wrapped line.
  async function sketchStore() {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [textNode({ id: 'a', x: 0, y: 0, width: 200, height: 80, text: 'a body' })],
        edges: [],
        facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
      })
    })
    return store
  }

  function depsMeasuring(store: FakeDocumentStore, ...families: string[]): ServerDeps {
    return {
      ...makeDeps(store),
      textMeasurer: async () => ({
        measure: constantRatioMeasureText,
        measurableFamilies: new Set([SPATIAL_THEME_FONT_FAMILY, ...families]),
      }),
    }
  }

  test('an installed family the theme names is declared', async () => {
    const tool = createCanvasRenderSvgTool(depsMeasuring(await sketchStore(), 'Yomogi'))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
      style: 'document',
    })
    expect(result.svg).toContain('font-family="Yomogi"')
  })

  test('a family the measurer cannot answer for degrades to the bundled one', async () => {
    const tool = createCanvasRenderSvgTool(depsMeasuring(await sketchStore()))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
      style: 'document',
    })
    expect(result.svg).not.toContain('Yomogi')
    expect(result.svg).toContain(`font-family="${SPATIAL_THEME_FONT_FAMILY}"`)
  })

  test('with no measurer supplied, only the bundled family is ever declared', async () => {
    const tool = createCanvasRenderSvgTool(makeDeps(await sketchStore()))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
      style: 'document',
    })
    expect(result.svg).not.toContain('Yomogi')
  })
})
