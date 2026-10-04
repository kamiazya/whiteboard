// `canvas_view`'s result is read by the MCP Apps widget, which lists the keys it
// wants by hand because canvas-viewer cannot import server-core. Neither side's
// type-check sees the other, so a key renamed on one side would leave the widget
// drawing an empty board while every test on each side stayed green. This is the
// one place the real tool output meets the widget's reader.

import {
  constantRatioMeasureText,
  createSpatialTheme,
  layoutSpatialCanvas,
  loadedReferenceFromWire,
  renderSceneToSvg,
} from '@kamiazya/whiteboard-canvas-render'
import { parseViewerScene } from '@kamiazya/whiteboard-canvas-viewer/scene'
import { readCanvasViewResult } from '@kamiazya/whiteboard-canvas-viewer/widget-canvas-view-result'
import {
  writeCommentThread,
  writeDocumentKind,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { VISUAL_TAGS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import {
  canvasViewOutputSchema,
  createCanvasRenderSvgTool,
  createCanvasViewTool,
  type ServerDeps,
  TAG_LIBRARY_PATH,
} from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))
const tmp = withTempDataDir('whiteboard-canvas-view-contract-')
const { resolveTestServerDeps } = await import('../routes/_test-helpers.js')

// A fresh workspace id per run: the document store is module-level and keyed
// by workspace, so a repeat that reused the id would read the previous run's
// record and resolve none of this run's references.
let workspaceSeq = 0
const freshWorkspaceId = (): string => `contract-${workspaceSeq++}`

async function save(
  deps: ServerDeps,
  workspaceId: string,
  documentId: string,
  doc: LoroDoc,
): Promise<void> {
  doc.commit()
  const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1_000_000)
  await deps.documentStore.saveSnapshot({
    docRef: { kind: 'document', workspaceId, documentId },
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

const thread = {
  id: 'set',
  anchor: { kind: 'spatial' as const, nodeIds: ['t1', 'f1'], x: 0, y: 0, width: 520, height: 220 },
  status: 'open' as const,
  messages: [{ id: 'm', body: 'both of these' }],
}

// A board that exercises every key the widget reads: a text node, a file node
// that resolves to a markdown body, a conversation, and a theme that names a
// family the daemon's catalogue can place.
async function seedBoard(deps: ServerDeps, workspaceId: string): Promise<string> {
  await deps.documentIndex.createWorkspace({ workspaceId })
  const note = await deps.documentIndex.createDocument({
    workspaceId,
    path: 'notes',
    kind: 'markdown',
  })
  const noteDoc = new LoroDoc()
  writeDocumentKind(noteDoc, 'markdown')
  writeMarkdownBody(noteDoc, '# Weekly notes\n\nShipped it.')
  await save(deps, workspaceId, note.documentId, noteDoc)

  const board = await deps.documentIndex.createDocument({
    workspaceId,
    path: 'board',
    kind: 'spatial',
  })
  const boardDoc = new LoroDoc()
  writeDocumentKind(boardDoc, 'spatial')
  writeSpatialCanvas(boardDoc, {
    nodes: [
      textNode({ id: 't1', x: 0, y: 0, width: 100, height: 50, text: 'hello' }),
      fileNode({ id: 'f1', x: 200, y: 0, width: 320, height: 220, file: note.documentId }),
    ],
    edges: [],
    facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
  })
  writeCommentThread(boardDoc, thread)
  await save(deps, workspaceId, board.documentId, boardDoc)
  return board.documentId
}

describe("canvas_view's result read by the widget's reader", () => {
  it('recovers the scene, threads, references, style and theme font the tool sent', async () => {
    const deps = await resolveTestServerDeps(tmp.dir)
    const workspaceId = freshWorkspaceId()
    const documentId = await seedBoard(deps, workspaceId)

    const result = await createCanvasViewTool(deps).execute({
      workspaceId,
      documentId,
      style: 'document',
    })
    // The subject is present before anything is compared against it: a reader
    // that dropped an absent key would otherwise "agree" with an empty tool.
    expect(result.threads).toHaveLength(1)
    expect(Object.keys(result.references)).toHaveLength(1)
    expect(result.themeFont?.family).toBe('Yomogi')

    // Through JSON, as it crosses the host boundary.
    const wire = JSON.parse(JSON.stringify(canvasViewOutputSchema.parse(result)))
    const read = readCanvasViewResult({ structuredContent: wire })

    expect(read.workspaceId).toBe(workspaceId)
    expect(read.documentId).toBe(documentId)
    expect(parseViewerScene(read.scene)).toBeDefined()
    expect(read.scene).toEqual(wire.scene)
    expect(read.threads).toEqual(result.threads)
    expect(read.references).toEqual(
      Object.fromEntries(
        Object.entries(result.references).map(([key, value]) => [
          key,
          loadedReferenceFromWire(value),
        ]),
      ),
    )
    expect(read.style).toBe('document')
    expect(read.themeFont).toEqual(result.themeFont)
  })
})

// A board coloured by intent: no node carries a colour of its own, the
// workspace's tag library declares one per value. The widget has no store to
// read a library from, so what it draws can only match the export if the tool
// resolves the library into the scene it sends.
async function seedTaggedBoard(
  deps: ServerDeps,
  workspaceId: string,
  withLibrary: boolean,
): Promise<string> {
  await deps.documentIndex.createWorkspace({ workspaceId })
  if (withLibrary) {
    const library = await deps.documentIndex.createDocument({
      workspaceId,
      path: TAG_LIBRARY_PATH,
      kind: 'markdown',
    })
    const libraryDoc = new LoroDoc()
    writeDocumentKind(libraryDoc, 'markdown')
    writeFacets(libraryDoc, {
      [VISUAL_TAGS_KEY]: {
        keys: { health: { values: { ok: { color: '4' }, failing: { color: '1' } } } },
      },
    } as never)
    await save(deps, workspaceId, library.documentId, libraryDoc)
  }
  const board = await deps.documentIndex.createDocument({
    workspaceId,
    path: 'board',
    kind: 'spatial',
  })
  const boardDoc = new LoroDoc()
  writeDocumentKind(boardDoc, 'spatial')
  writeSpatialCanvas(boardDoc, {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'api', tags: ['health:ok'] }),
      textNode({
        id: 'b',
        x: 300,
        y: 0,
        width: 100,
        height: 50,
        text: 'db',
        tags: ['health:failing'],
      }),
    ],
    edges: [],
  })
  await save(deps, workspaceId, board.documentId, boardDoc)
  return board.documentId
}

// What the widget does with a canvas_view result: read it, then lay the scene
// out with `CanvasViewer`'s own layout call — which has no library to give.
function viewerSvg(structuredContent: unknown): string {
  const read = readCanvasViewResult({ structuredContent })
  const parsed = parseViewerScene(read.scene)
  if (!parsed.ok) throw new Error('canvas_view sent a scene the widget cannot parse')
  const scene = layoutSpatialCanvas(parsed.value, {
    measure: constantRatioMeasureText,
    appearance: createSpatialTheme({ mode: 'light' }),
  })
  return renderSceneToSvg(scene, { width: 800, height: 400, padding: 0 })
}

const PAINTED = /(?:fill|stroke)="(#[0-9a-f]{6})"/gi
const paintedColours = (svg: string): Set<string> =>
  new Set([...svg.matchAll(PAINTED)].map((match) => match[1]?.toLowerCase() ?? ''))
// The two greens and two reds the library's presets '4' and '1' resolve to.
const DECLARED_FILLS = ['#d1fae5', '#059669', '#fee2e2', '#dc2626']

describe('canvas_view draws a board as wb_scene_render does (colour by intent)', () => {
  it('colours a tagged board through the workspace library and lists its legend', async () => {
    const deps = await resolveTestServerDeps(tmp.dir)
    const workspaceId = freshWorkspaceId()
    const documentId = await seedTaggedBoard(deps, workspaceId, true)

    const exported = await createCanvasRenderSvgTool(deps).execute({
      workspaceId,
      documentId,
      embedReferences: false,
      style: 'clean',
    })
    const viewed = viewerSvg(
      JSON.parse(
        JSON.stringify(
          canvasViewOutputSchema.parse(
            await createCanvasViewTool(deps).execute({ workspaceId, documentId }),
          ),
        ),
      ),
    )

    // The subject is present: the export itself is coloured and has a legend,
    // so a viewer that agreed with an uncoloured export would not pass.
    const exportedColours = paintedColours(exported.svg)
    for (const colour of DECLARED_FILLS) expect(exportedColours.has(colour)).toBe(true)
    expect(exported.svg).toContain('data-wb-legend')

    const viewedColours = paintedColours(viewed)
    for (const colour of DECLARED_FILLS) expect(viewedColours.has(colour)).toBe(true)
    expect(viewed).toContain('data-wb-legend')
    const legend = viewed.slice(viewed.indexOf('data-wb-legend'))
    expect(legend).toContain('>health<')
    expect(legend).toContain('>failing<')
    expect(legend).toContain('>ok<')
  })

  it('draws the same board grey, with no legend, when the workspace declares no library', async () => {
    const deps = await resolveTestServerDeps(tmp.dir)
    const workspaceId = freshWorkspaceId()
    const documentId = await seedTaggedBoard(deps, workspaceId, false)

    const viewed = viewerSvg(
      JSON.parse(
        JSON.stringify(
          canvasViewOutputSchema.parse(
            await createCanvasViewTool(deps).execute({ workspaceId, documentId }),
          ),
        ),
      ),
    )
    for (const colour of DECLARED_FILLS) expect(paintedColours(viewed).has(colour)).toBe(false)
    expect(viewed).not.toContain('data-wb-legend')
  })
})
