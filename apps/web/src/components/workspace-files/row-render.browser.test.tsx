/**
 * The spatial half of the row renderer, end to end in a real browser.
 *
 * The markdown half is covered by the worker parity test; this one exists
 * because nothing else exercises snapshot bytes → LoroDoc → the pool's
 * `layout` message → an SVG. Every piece is proven separately and the seam
 * between them is not, which is exactly where a wrong key or a stale message
 * kind hides.
 */

import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import { createInTabRenderBroker } from '../../lib/render-broker.js'
import {
  createRowRenderLoader,
  type DocumentRender,
  EMPTY_DOCUMENT,
  type RowRender,
} from './load-row-render.js'

/** The picture an answer carries, or undefined for one that is not a picture. */
function picture(answer: RowRender | null): DocumentRender | undefined {
  return answer === null || answer === EMPTY_DOCUMENT ? undefined : answer
}

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 200, height: 120, text: 'Alpha' }),
    textNode({ id: 'b', x: 300, y: 60, width: 200, height: 120, text: 'Beta' }),
  ],
  edges: [
    {
      id: 'e1',
      from: { node: 'a' },
      to: { node: 'b' },
    },
  ],
} as SpatialCanvas

function snapshotBytes(board: SpatialCanvas = canvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, board)
  return doc.export({ mode: 'snapshot' })
}

function sourceOf(
  bytes: Uint8Array,
  readTagLibrary?: () => Promise<TagLibrary>,
): WorkspaceFilesSource {
  return {
    listDocuments: async () => [],
    createDocument: async () => {},
    renameDocumentPath: async () => {},
    searchDocuments: async () => [],
    setDocumentName: async () => {},
    loadSpatialSnapshot: async () => bytes,
    loadMarkdown: async () => {
      throw new Error('a spatial document must not be read as OKF')
    },
    ...(readTagLibrary === undefined ? {} : { readTagLibrary }),
  }
}

it('renders a spatial document from its snapshot bytes through the pool', async () => {
  const bytes = snapshotBytes()
  const load = createRowRenderLoader({
    theme: 'light',
    broker: createInTabRenderBroker(),
    documents: () => [],
    source: sourceOf(bytes),
  })

  const drawn = await load({ documentId: 'd1', path: 'a/b', kind: 'spatial' })

  expect(drawn).not.toBeNull()
  expect(drawn).not.toBe(EMPTY_DOCUMENT)
  // The text proves it drew THIS canvas, not an empty one — an empty scene
  // also produces a valid <svg> and would pass a shape-only assertion.
  expect(picture(drawn)?.svg).toContain('Alpha')
  expect(picture(drawn)?.svg).toContain('Beta')
  expect(picture(drawn)?.bounds.w).toBeGreaterThan(0)
}, 60_000)

// The list draws a tagged board in the colour its workspace declares, as the
// editor does: the same board grey in the list and green once opened is two
// pictures of one document.
it('draws a tagged board in the colour its tag library declares', async () => {
  const tagged: SpatialCanvas = {
    nodes: [
      textNode({
        id: 'api',
        x: 0,
        y: 0,
        width: 200,
        height: 120,
        text: 'api',
        tags: ['health:ok'],
      }),
    ],
    edges: [],
  }
  const bytes = snapshotBytes(tagged)
  const green = SPATIAL_LIGHT_PALETTE.presets['4'].fill
  const draw = (readTagLibrary?: () => Promise<TagLibrary>) =>
    createRowRenderLoader({
      theme: 'light',
      broker: createInTabRenderBroker(),
      documents: () => [],
      source: sourceOf(bytes, readTagLibrary),
    })({ documentId: 'tagged', path: 'tagged', kind: 'spatial' })

  const declared = await draw(async () => ({ health: { values: { ok: { color: '4' } } } }))
  const undeclared = await draw()

  expect(picture(declared)?.svg).toContain(green)
  // The control: the colour comes from the library, not from the board.
  expect(picture(undeclared)?.svg).not.toContain(green)
}, 60_000)

// A board of file nodes previews as the board that opens: what each node
// embeds is drawn inside it, not left a bare card.
it('draws the board a file node embeds inside the thumbnail', async () => {
  const inner: SpatialCanvas = {
    nodes: [
      textNode({ id: 'i', x: 0, y: 0, width: 200, height: 120, text: 'Embedded', color: '4' }),
    ],
    edges: [],
  }
  const outer: SpatialCanvas = {
    nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 400, height: 300, file: 'boards/inner' })],
    edges: [],
  }
  const board: WorkspaceDocumentEntry = {
    documentId: 'outer',
    path: 'boards/outer',
    kind: 'spatial',
    contentDigest: '0000000000000001',
  }
  const embedded: WorkspaceDocumentEntry = {
    documentId: 'inner',
    path: 'boards/inner',
    kind: 'spatial',
    contentDigest: '0000000000000002',
  }
  const bytes = new Map([
    ['outer', snapshotBytes(outer)],
    ['inner', snapshotBytes(inner)],
  ])
  const green = SPATIAL_LIGHT_PALETTE.presets['4'].fill
  const draw = (listed: readonly WorkspaceDocumentEntry[]) =>
    createRowRenderLoader({
      theme: 'light',
      broker: createInTabRenderBroker(),
      documents: () => listed,
      source: {
        ...sourceOf(new Uint8Array()),
        loadSpatialSnapshot: async (entry) => bytes.get(entry.documentId) ?? new Uint8Array(),
      },
    })(board)

  const drawn = await draw([board, embedded])
  // The control: a target the list cannot resolve leaves the card.
  const dangling = await draw([board])

  expect(picture(drawn)?.svg).toContain(green)
  expect(picture(drawn)?.svg).toContain('Embedded')
  expect(picture(dangling)?.svg).not.toContain(green)
}, 60_000)

// A note that is mostly `![[…]]` previews as the note that opens, not as the
// syntax that names what it embeds.
it('draws the note a body embeds inside the thumbnail', async () => {
  const note: WorkspaceDocumentEntry = {
    documentId: 'outer-note',
    path: 'notes/outer',
    kind: 'markdown',
    contentDigest: '0000000000000003',
  }
  const embedded: WorkspaceDocumentEntry = {
    documentId: 'inner-note',
    path: 'notes/inner',
    kind: 'markdown',
    contentDigest: '0000000000000004',
  }
  const bodies = new Map([
    ['outer-note', 'Before\n\n![[notes/inner]]'],
    ['inner-note', 'Quoted paragraph'],
  ])
  const draw = (listed: readonly WorkspaceDocumentEntry[]) =>
    createRowRenderLoader({
      theme: 'light',
      broker: createInTabRenderBroker(),
      documents: () => listed,
      source: {
        ...sourceOf(new Uint8Array()),
        loadMarkdown: async (entry) => ({ body: bodies.get(entry.documentId) ?? '' }),
      },
    })(note)

  const drawn = await draw([note, embedded])
  const dangling = await draw([note])

  expect(picture(drawn)?.svg).toContain('Quoted paragraph')
  expect(picture(dangling)?.svg).not.toContain('Quoted paragraph')
}, 60_000)

// A mood board previews as the pictures it holds, not as a grid of "Image"
// cards: the picture's own bytes ride into the stored thumbnail as data.
it('draws a picture a board holds inside the thumbnail', async () => {
  const pictured: SpatialCanvas = {
    nodes: [fileNode({ id: 'p', x: 0, y: 0, width: 200, height: 120, file: 'asset:pic' })],
    edges: [],
  }
  // A 1x1 PNG.
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    ),
    (char) => char.charCodeAt(0),
  )
  const board: WorkspaceDocumentEntry = {
    documentId: 'mood',
    path: 'boards/mood',
    kind: 'spatial',
    contentDigest: '0000000000000005',
  }
  const draw = (loadImage: WorkspaceFilesSource['loadImage']) =>
    createRowRenderLoader({
      theme: 'light',
      broker: createInTabRenderBroker(),
      documents: () => [board],
      source: { ...sourceOf(snapshotBytes(pictured)), ...(loadImage ? { loadImage } : {}) },
    })(board)

  const drawn = await draw(async () => new Blob([png], { type: 'image/png' }))
  // The control: a keeper that holds no such picture leaves the card.
  const missing = await draw(async () => undefined)

  const svg = new DOMParser().parseFromString(picture(drawn)?.svg ?? '', 'image/svg+xml')
  expect(svg.querySelector('image')?.getAttribute('href')).toMatch(/^data:image\/png;base64,/)
  expect(picture(missing)?.svg).not.toContain('<image')
}, 60_000)
