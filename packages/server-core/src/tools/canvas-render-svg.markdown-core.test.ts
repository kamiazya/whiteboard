import type {
  LayoutCore,
  MarkdownLayoutCore,
  MarkdownNoteRequest,
} from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { REFUSAL_NOTE, refusalNote } from '../render/refusal-note.js'
import type { ServerDeps } from '../server-deps.js'
import { FakeDocumentStore, placeUnlessPlaced, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasRenderSvgTool } from './canvas-render-svg.js'

const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const BOARD_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const WORKSPACE_ID = 'ws-1'
const BODY = `# Plan\n\nShip it.\n\n## Detail\n\n![[${BOARD_ID}]]\n`

/** A note embedding a board, both placed in the workspace. */
async function workspace(): Promise<FakeDocumentStore> {
  const store = new FakeDocumentStore()
  await placeUnlessPlaced(store, WORKSPACE_ID, NOTE_ID)
  await seedDoc(store, NOTE_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, BODY)
  })
  await seedDoc(store, BOARD_ID, (doc) => {
    writeSpatialCanvas(doc, {
      nodes: [textNode({ id: 'n', x: 0, y: 0, width: 120, height: 60, text: 'db' })],
      edges: [],
    })
  })
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: BOARD_ID,
    path: 'board',
    kind: 'spatial',
  })
  return store
}

/** A markdown core whose scene is one marked run, keeping what it was asked. */
function markingCore(answer: MarkdownLayoutCore['layoutMarkdown']) {
  const requests: MarkdownNoteRequest[] = []
  const core = fakeLayoutCore({
    markdown: {
      layoutMarkdown: (request, highlight, measure) => {
        // The daemon renders notes; a comment's request never reaches this tool.
        if (request.kind === 'markdown') requests.push(request)
        return answer(request, highlight, measure)
      },
    },
    // A refused note is drawn as the real core's notice.
    query: testLayoutCore().query,
  })
  return { core, requests }
}

const marked: MarkdownLayoutCore['layoutMarkdown'] = () => ({
  scene: {
    nodes: [
      {
        kind: 'textRun',
        text: 'from the core',
        bbox: { x: 0, y: 0, w: 100, h: 20 },
        baseline: 16,
        font: { family: 'Roboto', weight: 400, style: 'normal', sizePx: 16 },
      },
    ],
  } as never,
  degradations: [],
  svg: '<svg>from the core</svg>',
})

async function render(
  core: LayoutCore,
  input: { embedReferences?: boolean; fragment?: string } = {},
) {
  const deps: ServerDeps = {
    ...makeTestDeps({ documentStore: await workspace() }),
    layoutCore: async () => core,
  }
  deps.documentIndex = (deps.documentStore as FakeDocumentStore).documentIndex
  return createCanvasRenderSvgTool(deps).execute({
    workspaceId: WORKSPACE_ID,
    documentId: NOTE_ID,
    embedReferences: input.embedReferences ?? false,
    comments: false,
    style: 'clean',
    ...(input.fragment === undefined ? {} : { fragment: input.fragment }),
  })
}

describe('wb_scene_render of a note and the markdown core', () => {
  test('draws a note the core refuses as the notice, and says why beside the SVG', async () => {
    const refused = { code: 'input-too-large', reason: 'bodies' } as const
    const { core } = markingCore(() => ({ refused }))
    const deps: ServerDeps = {
      ...makeTestDeps({ documentStore: await workspace() }),
      layoutCore: async () => core,
    }
    deps.documentIndex = (deps.documentStore as FakeDocumentStore).documentIndex
    const { [REFUSAL_NOTE]: note, ...output } = await createCanvasRenderSvgTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: NOTE_ID,
      embedReferences: false,
      comments: false,
      style: 'clean',
    })
    expect(output.svg).not.toContain('Ship it')
    expect(output.svg).toContain('Too much to draw here')
    expect(note).toBe(refusalNote(refused))
  })

  test('lays the note out through the core ServerDeps hands it', async () => {
    const { core, requests } = markingCore(marked)
    const { svg } = await render(core)
    expect(svg).toBe('<svg>from the core</svg>')
    expect(requests).toMatchObject([
      { kind: 'markdown', body: BODY, maxWidth: 720, svg: { viewBox: 'document' } },
    ])
    expect(requests[0]).not.toHaveProperty('references')
  })

  test('hands the core the references as a wire, never skipping them', async () => {
    const { core, requests } = markingCore(marked)
    await render(core, { embedReferences: true })
    const entries = requests[0]?.references?.entries.map(([key]) => key)
    expect(entries).toEqual([BOARD_ID])
  })

  test('hands the core a heading as its section, and names one the core reports missing', async () => {
    const { core, requests } = markingCore(marked)
    await render(core, { fragment: 'Detail' })
    expect(requests[0]?.section).toBe('Detail')
    const missing = markingCore(() => ({ missing: 'section' }))
    await expect(render(missing.core, { fragment: 'Nowhere' })).rejects.toThrow(
      /has no heading "Nowhere"/,
    )
  })
})
