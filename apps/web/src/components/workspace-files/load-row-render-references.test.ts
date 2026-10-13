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

const pictured: WorkspaceDocumentEntry = {
  documentId: 'n3',
  path: 'notes/c',
  kind: 'markdown',
  contentDigest: 'eeeeeeeeeeeeeeee',
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
    ['n3', '![[asset:pic]] beside ![[notes/a]]'],
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

  // A stored picture is drawn from the file store, so the wire never carries
  // it and the keeper is never asked for it as a document.
  it('leaves a picture a note embeds off the wire it reads', async () => {
    const d = deps([pictured, embedded])

    expect(await createRowRenderLoader(d)(pictured)).toEqual(DRAWN)

    const wire = d.renderMarkdown.mock.calls.at(-1)?.[3]?.references
    expect(wire?.entries.map(([key]) => key)).toEqual(['notes/a'])
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

    d.source.loadMarkdown.mockImplementation(async () => ({ body: '# Edited' }))
    listed = [board, { ...embedded, contentDigest: 'dddddddddddddddd' }]
    await load(board)
    expect(drawnWith()).toHaveLength(2)
    expect(entryOf(drawnWith().at(-1)?.[4], 'notes/a')).toMatchObject({ body: '# Edited' })
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

  // A note the renderer draws nothing of has no picture, whatever it names:
  // it must not come back as a picture of nothing marked as missing embeds.
  it('answers no picture for a note that names a document and draws nothing', async () => {
    const d = { ...deps([note, embedded]), renderMarkdown: vi.fn(async () => null) }

    expect(await createRowRenderLoader(d)(note)).toBeNull()
    expect(d.renderMarkdown).toHaveBeenCalled()
  })

  // Total: an embedded document that will not read leaves the row with the
  // picture it could draw, never without one.
  it('keeps the bare picture when an embedded document cannot be read', async () => {
    const d = deps([board, embedded])
    d.source.loadMarkdown.mockRejectedValue(new Error('503'))
    expect(await createRowRenderLoader(d)(board)).toEqual(BARE)
  })
})

const pictureBoard: WorkspaceDocumentEntry = {
  documentId: 'p1',
  path: 'moodboard',
  kind: 'spatial',
  contentDigest: '1111111111111111',
}

const pictureCanvas: SpatialCanvas = {
  nodes: [fileNode({ id: 'i', x: 0, y: 0, width: 200, height: 120, file: 'asset:pic' })],
  edges: [],
}

// The limits `docs/how-to/choose-a-theme.md` states, so a change to either
// in `row-references.ts` fails here until the page says it too.
const ROW_IMAGE_MAX_BYTES = 256 * 1024
const ROW_IMAGES_MAX_BYTES = 512 * 1024

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

/** A source that keeps one stored picture, the bytes a test hands it. */
function picturing(d: ReturnType<typeof deps>, bytes: () => Uint8Array, type = 'image/png') {
  const loadImage = vi.fn(async () => new Blob([bytes() as BlobPart], { type }))
  d.source.loadSpatialSnapshot.mockImplementation(async () => snapshotOf(pictureCanvas))
  return { ...d, source: { ...d.source, loadImage } }
}

const imageOf = (wire: ReferenceWire | undefined, ref: string) =>
  wire?.extras.find(([key]) => key === ref)?.[1].image

describe('a row draws the pictures its document holds', () => {
  // A mood board is a board of pictures: a miniature of grey cards is a
  // different picture from the one that opens.
  it('hands a board of pictures their bytes inline', async () => {
    const d = picturing(deps([pictureBoard]), () => PNG_BYTES)

    expect(await createRowRenderLoader(d)(pictureBoard)).toEqual(DRAWN)

    const wire = d.renderSpatial.mock.calls.at(-1)?.[4]
    expect(imageOf(wire, 'asset:pic')?.href).toBe(
      `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`,
    )
  })

  it('draws a note again for a picture it holds inline', async () => {
    const d = picturing(deps([note]), () => PNG_BYTES)
    d.source.loadMarkdown.mockImplementation(async () => ({ body: '![a cat](asset:pic)' }))

    expect(await createRowRenderLoader(d)(note)).toEqual(DRAWN)

    const wire = d.renderMarkdown.mock.calls.at(-1)?.[3]?.references
    expect(imageOf(wire, 'asset:pic')?.href).toMatch(/^data:image\/png;base64,/)
  })

  // The bytes are in the stored picture, so a picture past the cap would
  // make every row that holds it that much heavier to keep.
  it('leaves a picture over the cap as its card', async () => {
    const d = picturing(deps([pictureBoard]), () => new Uint8Array(ROW_IMAGE_MAX_BYTES + 1))

    await createRowRenderLoader(d)(pictureBoard)

    const wire = d.renderSpatial.mock.calls.at(-1)?.[4]
    expect(imageOf(wire, 'asset:pic')).toBeUndefined()
  })

  // The row's budget is spent in the order its content names the pictures,
  // so which ones draw is the same every time.
  it('leaves the pictures past the row budget as their cards', async () => {
    const each = ROW_IMAGE_MAX_BYTES
    const fit = Math.floor(ROW_IMAGES_MAX_BYTES / each)
    const refs = Array.from({ length: fit + 1 }, (_, index) => `asset:p${index}`)
    const d = picturing(deps([pictureBoard]), () => new Uint8Array(each))
    d.source.loadSpatialSnapshot.mockImplementation(async () =>
      snapshotOf({
        nodes: refs.map((file, index) =>
          fileNode({ id: `n${index}`, x: index * 300, y: 0, width: 200, height: 120, file }),
        ),
        edges: [],
      }),
    )

    await createRowRenderLoader(d)(pictureBoard)

    const wire = d.renderSpatial.mock.calls.at(-1)?.[4]
    expect(refs.map((ref) => imageOf(wire, ref) !== undefined)).toEqual([
      ...refs.slice(0, fit).map(() => true),
      false,
    ])
  })

  // The key names what was drawn, so new bytes are a new picture and the
  // memo must not answer the old one.
  it('draws the row again when a picture it holds changes', async () => {
    let bytes = PNG_BYTES
    const d = picturing(deps([pictureBoard]), () => bytes)
    const drawnWith = () => d.renderSpatial.mock.calls.filter((call) => call[4] !== undefined)

    await createRowRenderLoader(d)(pictureBoard)
    await createRowRenderLoader(d)(pictureBoard)
    expect(drawnWith()).toHaveLength(1)

    bytes = new Uint8Array([...PNG_BYTES, 4])
    await createRowRenderLoader(d)(pictureBoard)
    expect(drawnWith()).toHaveLength(2)
  })
})
