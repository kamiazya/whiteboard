// The picture the MCP Apps widget shows is laid out HERE (ADR-0054 step 7,
// q54): the widget lays nothing out, so what this answers is exactly what a
// person sees in the chat — the board, what its file nodes name, its
// conversations, the theme's paper — and the boxes a click on it is tested
// against.

import {
  type CanvasLayoutRequest,
  canvasViewPictureSchema,
  hitBoxesOf,
  SPATIAL_LIGHT_PALETTE,
} from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import { fromJsonCanvas } from '@kamiazya/whiteboard-codec'
import {
  writeCommentThread,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { fileNode, groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, placeUnlessPlaced, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasViewTool } from './canvas-view.js'
import { canvasViewPicture } from './canvas-view-picture.js'

const BOARD_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const WORKSPACE_ID = '01ZVM89A4A1V9FS03Z9J64KEK1'

async function seed(store: FakeDocumentStore, facets?: Record<string, unknown>) {
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    path: 'board',
    documentId: BOARD_ID,
    kind: 'spatial',
  })
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    path: 'notes',
    documentId: NOTE_ID,
    kind: 'markdown',
  })
  await seedDoc(store, BOARD_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, {
      nodes: [
        textNode({ id: 't1', x: 40, y: 40, width: 120, height: 50, text: 'hello' }),
        fileNode({ id: 'f1', x: 240, y: 40, width: 320, height: 220, file: NOTE_ID }),
        groupNode({ id: 'g1', x: 0, y: 0, width: 600, height: 300, label: 'Area' }),
      ],
      edges: [],
      ...(facets === undefined ? {} : { facets: facets as never }),
    })
    writeCommentThread(doc, {
      id: 'th',
      anchor: { kind: 'spatial', x: 100, y: 200, nodeId: 't1' },
      status: 'open',
      messages: [{ id: 'm', body: 'a pinned remark' }],
    })
  })
  await seedDoc(store, NOTE_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, '# Weekly notes\n\nShipped it.')
  })
  await placeUnlessPlaced(store, WORKSPACE_ID, BOARD_ID)
}

async function view(style?: 'document', facets?: Record<string, unknown>) {
  const store = new FakeDocumentStore()
  await seed(store, facets)
  const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
  const result = await createCanvasViewTool(deps).execute({
    workspaceId: WORKSPACE_ID,
    documentId: BOARD_ID,
    ...(style === undefined ? {} : { style }),
  })
  return { result, picture: await canvasViewPicture(deps, result) }
}

describe('canvas_view picture', () => {
  test('hands the core what its file nodes name as data, so a board with references is laid out', async () => {
    const store = new FakeDocumentStore()
    await seed(store)
    const asked: CanvasLayoutRequest[] = []
    const refused = { code: 'input-too-large', reason: 'too-many-elements' } as const
    const core = fakeLayoutCore({
      layout: {
        layoutSpatialCanvas: (request) => {
          asked.push(request)
          return { refused }
        },
      },
      // The refusal is drawn as the real core's notice.
      query: testLayoutCore().query,
    })
    const deps = {
      ...makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
      layoutCore: async () => core,
    }
    const result = await createCanvasViewTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: BOARD_ID,
    })

    await canvasViewPicture(deps, result)

    expect(asked).toHaveLength(1)
    expect(JSON.stringify(asked[0])).toContain('Shipped it.')
  })

  test('draws the board with what its file nodes name and its conversation', async () => {
    const { picture } = await view()

    expect(canvasViewPictureSchema.parse(picture)).toEqual(picture)
    // An enveloped document, so the widget can scale it to its frame.
    expect(picture.svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="[\d.]+" height="[\d.]+" viewBox="/,
    )
    expect(picture.svg).toContain('>hello<')
    // The referenced note's body, which only the server can read.
    expect(picture.svg).toContain('Shipped it.')
    // The conversation, from the threads beside the scene.
    expect(picture.svg).toContain('>a pinned remark<')
  })

  test('hands over every node box in paint order, the frame flagged', async () => {
    const { result, picture } = await view()

    expect(picture.boxes).toEqual(hitBoxesOf(fromJsonCanvas(result.scene).nodes))
    expect(picture.boxes.map((box) => box.id)[0]).toBe('g1')
    expect(picture.boxes.find((box) => box.id === 'g1')?.container).toBe(true)
    expect(picture.boxes.find((box) => box.id === 't1')).toEqual({
      id: 't1',
      box: { x: 40, y: 40, width: 120, height: 50 },
    })
  })

  test("paints the theme's paper under a themed board, and the bundled paper otherwise", async () => {
    const theme = { 'visual.theme/v0': { theme: 'visual.neon' } }
    const plain = await view(undefined, theme)
    const themed = await view('document', theme)

    expect(plain.picture.svg).toContain(`fill="${SPATIAL_LIGHT_PALETTE.surface}"`)
    expect(themed.picture.svg).not.toContain(
      `fill="${SPATIAL_LIGHT_PALETTE.surface}" role="presentation"`,
    )
    expect(themed.picture.svg).toContain('wb-glow')
  })

  test('declares a theme family only where this daemon can measure it (q80)', async () => {
    // The test deps carry no measurer, so the bundled family is all there is:
    // `visual.sketch` names Yomogi, and the picture still says Roboto.
    const { picture } = await view('document', { 'visual.theme/v0': { theme: 'visual.sketch' } })

    expect(picture.svg).toContain('Roboto')
    expect(picture.svg).not.toContain('Yomogi')
  })
})
