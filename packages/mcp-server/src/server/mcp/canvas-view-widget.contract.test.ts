// `canvas_view`'s result is read by the MCP Apps widget, which lists the keys it
// wants by hand because canvas-viewer cannot import server-core. Neither side's
// type-check sees the other, so a key renamed on one side would leave the widget
// drawing an empty board while every test on each side stayed green. This is the
// one place the real tool output meets the widget's reader.

import { loadedReferenceFromWire } from '@kamiazya/whiteboard-canvas-render'
import { parseViewerScene } from '@kamiazya/whiteboard-canvas-viewer/scene'
import { readCanvasViewResult } from '@kamiazya/whiteboard-canvas-viewer/widget-canvas-view-result'
import {
  writeCommentThread,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import {
  canvasViewOutputSchema,
  createCanvasViewTool,
  type ServerDeps,
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
