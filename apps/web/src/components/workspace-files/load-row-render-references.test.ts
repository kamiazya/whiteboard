import type { ReferenceWire } from '@kamiazya/whiteboard-canvas-render'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { createInTabRenderBroker } from '../../lib/render-broker.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { createRowRenderLoader, type RowRenderDeps } from './load-row-render.js'

/** What a note's render is handed once it draws its embeds. */
type MarkdownEmbeds = Parameters<NonNullable<RowRenderDeps['renderMarkdown']>>[3]

const BARE = { svg: '<svg>bare</svg>', bounds: { x: 0, y: 0, w: 10, h: 10 } }
const DRAWN = { svg: '<svg>drawn</svg>', bounds: { x: 0, y: 0, w: 10, h: 10 } }

function snapshotOf(canvas: SpatialCanvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc.export({ mode: 'snapshot' })
}

const boardCanvas: SpatialCanvas = {
  nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 200, height: 120, file: 'notes/a' })],
  edges: [],
}

const board: WorkspaceDocumentEntry = {
  documentId: 'b1',
  path: 'board',
  kind: 'spatial',
  contentDigest: 'b0b0b0b0b0b0b0b0',
}
const embedded: WorkspaceDocumentEntry = {
  documentId: 'n1',
  path: 'notes/a',
  kind: 'markdown',
  contentDigest: 'aaaaaaaaaaaaaaaa',
}
const note: WorkspaceDocumentEntry = {
  documentId: 'n2',
  path: 'notes/b',
  kind: 'markdown',
  contentDigest: 'cccccccccccccccc',
}

/**
 * The renderers answer as the worker does: a picture drawn without the
 * documents its subject names says so, and one drawn with them does not.
 */
function deps(
  listed: readonly WorkspaceDocumentEntry[] | (() => readonly WorkspaceDocumentEntry[]),
) {
  const bodies = new Map([
    ['n1', '# Embedded'],
    ['n2', 'see ![[notes/a]]'],
  ])
  const source = fakeFilesSource({
    loadMarkdown: async (entry) => ({ body: bodies.get(entry.documentId) ?? '' }),
    loadSpatialSnapshot: async () => snapshotOf(boardCanvas),
  })
  return {
    source,
    theme: 'light',
    broker: createInTabRenderBroker(),
    documents: typeof listed === 'function' ? listed : () => listed,
    renderSpatial: vi.fn(
      async (_s: Uint8Array, _t: unknown, _l: unknown, _k?: string, references?: ReferenceWire) =>
        references === undefined ? { ...BARE, referencesOmitted: true as const } : DRAWN,
    ),
    renderMarkdown: vi.fn(async (_b: string, _w: number, _k?: string, embeds?: MarkdownEmbeds) =>
      embeds === undefined ? BARE : DRAWN,
    ),
  } satisfies RowRenderDeps
}

const entryOf = (wire: ReferenceWire | undefined, target: string) =>
  wire?.entries.find(([key]) => key === target)?.[1]

describe('a row draws what its document embeds', () => {
  // A board of file nodes previewed as bare cards is a different picture
  // from the one that opens.
  it('hands a spatial render the documents its file nodes name', async () => {
    const d = deps([board, embedded])

    expect(await createRowRenderLoader(d)(board)).toEqual(DRAWN)

    const wire = d.renderSpatial.mock.calls.at(-1)?.[4]
    expect(entryOf(wire, 'notes/a')).toMatchObject({ documentId: 'n1', body: '# Embedded' })
  })

  it('hands a markdown render the documents its body embeds', async () => {
    const d = deps([note, embedded])

    expect(await createRowRenderLoader(d)(note)).toEqual(DRAWN)

    const wire = d.renderMarkdown.mock.calls.at(-1)?.[3]?.references
    expect(entryOf(wire, 'notes/a')).toMatchObject({ documentId: 'n1', body: '# Embedded' })
  })

  // No churn for the common case: a document that names nothing is drawn
  // once, keyed as it always was, and reads nothing beyond itself.
  it('draws a document that names nothing once, and reads nothing else', async () => {
    const d = deps([embedded])
    await createRowRenderLoader(d)(embedded)
    expect(d.renderMarkdown).toHaveBeenCalledTimes(1)
    expect(d.renderMarkdown.mock.calls[0]?.[3]).toBeUndefined()
    expect(d.source.loadMarkdown).toHaveBeenCalledTimes(1)
  })

  // The picture is a picture of the embedded note too: editing it is a
  // different picture of the board, and the memo must not answer the old one.
  it('draws the row again when an embedded document changes', async () => {
    let listed = [board, embedded]
    const d = deps(() => listed)
    const load = createRowRenderLoader(d)

    await load(board)
    await load(board)
    const drawnWith = () => d.renderSpatial.mock.calls.filter((call) => call[4] !== undefined)
    expect(drawnWith()).toHaveLength(1)

    listed = [board, { ...embedded, contentDigest: 'dddddddddddddddd' }]
    await load(board)
    expect(drawnWith()).toHaveLength(2)
  })

  // A folder of boards that all embed one note reads it once per version,
  // not once per board.
  it('reads a document many rows embed once', async () => {
    const other = { ...board, documentId: 'b2', path: 'board2' }
    const d = deps([board, other, embedded])
    const load = createRowRenderLoader(d)

    await Promise.all([load(board), load(other)])

    const reads = d.source.loadMarkdown.mock.calls.filter(([entry]) => entry.documentId === 'n1')
    expect(reads).toHaveLength(1)
  })

  // Total: an embedded document that will not read leaves the row with the
  // picture it could draw, never without one.
  it('keeps the bare picture when an embedded document cannot be read', async () => {
    const d = deps([board, embedded])
    d.source.loadMarkdown.mockRejectedValue(new Error('503'))
    expect(await createRowRenderLoader(d)(board)).toEqual(BARE)
  })
})
