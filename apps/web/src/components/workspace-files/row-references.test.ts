import type { ReferenceWire } from '@kamiazya/whiteboard-canvas-render'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { createRowReferenceReader } from './row-references.js'

const note: WorkspaceDocumentEntry = {
  documentId: 'n0',
  path: 'notes/root',
  kind: 'markdown',
  contentDigest: '0000000000000000',
}
const alpha: WorkspaceDocumentEntry = {
  documentId: 'n1',
  path: 'notes/a',
  kind: 'markdown',
  contentDigest: 'aaaaaaaaaaaaaaaa',
  name: 'Alpha',
}
const inner: WorkspaceDocumentEntry = {
  documentId: 'n3',
  path: 'notes/c',
  kind: 'markdown',
  contentDigest: 'cccccccccccccccc',
}

function snapshotOf(canvas: SpatialCanvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc.export({ mode: 'snapshot' })
}

/**
 * A keeper holding the given bodies, listing whatever `listed` currently
 * answers. Both are mutable so a test can edit a document between rows.
 */
function keeper(bodies: Map<string, string>, listed: { current: WorkspaceDocumentEntry[] }) {
  const source = fakeFilesSource({
    loadMarkdown: async (entry) => ({ body: bodies.get(entry.documentId) ?? '' }),
  })
  const read = createRowReferenceReader(source, () => listed.current)
  return { source, read }
}

const entryOf = (wire: ReferenceWire, target: string) =>
  wire.entries.find(([key]) => key === target)?.[1]

const readsOf = (source: ReturnType<typeof fakeFilesSource>, documentId: string) =>
  source.loadMarkdown.mock.calls.filter(([entry]) => entry.documentId === documentId)

describe('what a row reads of the documents it embeds', () => {
  // The read is shared per document AND version: an edit is a new version,
  // and the old body must not answer for it — the picture drawn from it
  // would be cached as current under the new key.
  it('reads an embedded document again once its version changes', async () => {
    const bodies = new Map([
      ['n0', 'see ![[notes/a]]'],
      ['n1', '# Old'],
    ])
    const listed = { current: [note, alpha] }
    const { source, read } = keeper(bodies, listed)

    await read(note)
    await read(note)
    expect(readsOf(source, 'n1')).toHaveLength(1)

    bodies.set('n1', '# New')
    listed.current = [note, { ...alpha, contentDigest: 'dddddddddddddddd' }]
    const { wire } = await read(note)

    expect(entryOf(wire, 'notes/a')).toMatchObject({ body: '# New' })
  })

  it('reads a document with no version every time', async () => {
    const bodies = new Map([
      ['n0', 'see ![[notes/a]]'],
      ['n1', '# A'],
    ])
    const unversioned: WorkspaceDocumentEntry = { ...alpha, contentDigest: undefined }
    const { source, read } = keeper(bodies, { current: [note, unversioned] })

    await read(note)
    await read(note)

    expect(readsOf(source, 'n1')).toHaveLength(2)
  })

  // A transient failure must not leave every later row drawing bare cards
  // for as long as the loader lives.
  it('asks again for an embedded document whose read failed', async () => {
    const bodies = new Map([
      ['n0', 'see ![[notes/a]]'],
      ['n1', '# A'],
    ])
    const { source, read } = keeper(bodies, { current: [note, alpha] })
    let failed = false
    source.loadMarkdown.mockImplementation(async (entry) => {
      if (entry.documentId === 'n1' && !failed) {
        failed = true
        throw new Error('503')
      }
      return { body: bodies.get(entry.documentId) ?? '' }
    })

    await expect(read(note)).rejects.toThrow('503')
    const { wire } = await read(note)

    expect(entryOf(wire, 'notes/a')).toMatchObject({ body: '# A' })
  })

  it('reads an embed inside an embed', async () => {
    const bodies = new Map([
      ['n0', 'see ![[notes/a]]'],
      ['n1', 'and ![[notes/c]]'],
      ['n3', '# Inner'],
    ])
    const { read } = keeper(bodies, { current: [note, alpha, inner] })

    const { wire } = await read(note)

    expect(entryOf(wire, 'notes/c')).toMatchObject({ documentId: 'n3', body: '# Inner' })
  })

  it('reads what a board embeds from its own snapshot', async () => {
    const board: WorkspaceDocumentEntry = {
      documentId: 'b1',
      path: 'board',
      kind: 'spatial',
      contentDigest: 'b0b0b0b0b0b0b0b0',
    }
    const bodies = new Map([['n1', '# A']])
    const { source, read } = keeper(bodies, { current: [board, alpha] })
    source.loadSpatialSnapshot.mockImplementation(async () =>
      snapshotOf({
        nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 200, height: 120, file: 'notes/a' })],
        edges: [],
      }),
    )

    const { wire } = await read(board)

    expect(entryOf(wire, 'notes/a')).toMatchObject({ documentId: 'n1', body: '# A' })
  })

  it('carries the embedded document’s name, and no name for one nobody named', async () => {
    const bodies = new Map([['n0', '![[notes/a]] ![[notes/c]]']])
    const { read } = keeper(bodies, { current: [note, alpha, inner] })

    const { wire } = await read(note)

    expect(entryOf(wire, 'notes/a')).toMatchObject({ name: 'Alpha' })
    expect(entryOf(wire, 'notes/c')).not.toHaveProperty('name')
  })

  // The worker cannot read the listing: the path a link names and the label
  // it shows travel with the wire, or the picture labels links by address.
  it('hands the wire each embed’s address and label', async () => {
    const bodies = new Map([['n0', 'see ![[notes/a]]']])
    const { read } = keeper(bodies, { current: [note, alpha] })

    const { wire } = await read(note)

    expect(wire.aliases).toContainEqual(['notes/a', 'n1'])
    expect(wire.titles).toContainEqual(['n1', 'Alpha'])
  })

  it('records a target no listed document answers to as dangling, reading nothing', async () => {
    const bodies = new Map([['n0', 'see ![[notes/gone]]']])
    const { source, read } = keeper(bodies, { current: [note] })

    const { wire, key } = await read(note)

    expect(wire.entries).toEqual([['notes/gone', null]])
    expect(key).not.toBeNull()
    expect(source.loadMarkdown).toHaveBeenCalledTimes(1)
  })
})

describe('the key a row is drawn under', () => {
  const bodies = () =>
    new Map([
      ['n0', 'see ![[notes/a]]'],
      ['n1', '# A'],
      ['n9', '# A'],
    ])

  async function keyWith(listed: WorkspaceDocumentEntry[]) {
    return (await keeper(bodies(), { current: [note, ...listed] }).read(note)).key
  }

  // A link draws its target's label, so a renamed target is a different
  // picture even though nothing was written to either document.
  it('changes when an embedded document is renamed', async () => {
    expect(await keyWith([{ ...alpha, name: 'Beta' }])).not.toBe(await keyWith([alpha]))
  })

  it('changes when the embedded document changes', async () => {
    expect(await keyWith([{ ...alpha, contentDigest: 'dddddddddddddddd' }])).not.toBe(
      await keyWith([alpha]),
    )
  })

  // Same path, same name, same version string — but another document.
  it('changes when the path names another document', async () => {
    expect(await keyWith([{ ...alpha, documentId: 'n9' }])).not.toBe(await keyWith([alpha]))
  })

  it('is null when an embedded document has no version to notice a change by', async () => {
    expect(await keyWith([{ ...alpha, contentDigest: undefined }])).toBeNull()
  })
})

const ROW_IMAGE_MAX_BYTES = 256 * 1024

const png = (size: number) => new Blob([new Uint8Array(size) as BlobPart], { type: 'image/png' })

describe('the pictures a row draws inline', () => {
  function picturing(body: string, loadImage: (ref: string) => Promise<Blob | undefined>) {
    const bodies = new Map([['n0', body]])
    const { source, read } = keeper(bodies, { current: [note] })
    const images = vi.fn(async (_entry: WorkspaceDocumentEntry, ref: string) => loadImage(ref))
    const reader = createRowReferenceReader({ ...source, loadImage: images }, () => [note])
    return { images, read: reader, plain: read }
  }

  const imageOf = (wire: ReferenceWire, ref: string) =>
    wire.extras.find(([key]) => key === ref)?.[1].image

  it('draws a picture at exactly the cap, and leaves one past it a card', async () => {
    const at = picturing('![a](asset:pic)', async () => png(ROW_IMAGE_MAX_BYTES))
    const past = picturing('![a](asset:pic)', async () => png(ROW_IMAGE_MAX_BYTES + 1))

    expect(imageOf((await at.read(note)).wire, 'asset:pic')).toBeDefined()
    expect(imageOf((await past.read(note)).wire, 'asset:pic')).toBeUndefined()
  })

  // A card is a few bytes and spares re-reading a photo past the cap on
  // every scroll; a drawn picture's URL is not held by the loader.
  it('remembers a card, and reads a drawn picture again', async () => {
    const big = picturing('![a](asset:big)', async () => png(ROW_IMAGE_MAX_BYTES + 1))
    await big.read(note)
    await big.read(note)
    expect(big.images).toHaveBeenCalledTimes(1)

    const small = picturing('![a](asset:small)', async () => png(8))
    await small.read(note)
    await small.read(note)
    expect(small.images).toHaveBeenCalledTimes(2)
  })

  it('asks again for a picture whose read failed', async () => {
    let failed = false
    const once = picturing('![a](asset:pic)', async () => {
      if (!failed) {
        failed = true
        throw new Error('503')
      }
      return png(8)
    })

    await expect(once.read(note)).rejects.toThrow('503')
    expect(imageOf((await once.read(note)).wire, 'asset:pic')).toBeDefined()
  })

  it('draws a card for a keeper that keeps no pictures, and keys it as one', async () => {
    const { plain } = picturing('![a](asset:pic)', async () => png(8))
    const drawn = picturing('![a](asset:pic)', async () => png(8))

    const card = await plain(note)

    expect(imageOf(card.wire, 'asset:pic')).toBeUndefined()
    expect(card.key).not.toBe((await drawn.read(note)).key)
  })

  // A picture is drawn from the file store, never read as a document.
  it('reads no picture as a document', async () => {
    const { plain } = picturing('![[asset:pic]]', async () => png(8))
    const { wire } = await plain(note)
    expect(wire.entries).toEqual([])
  })
})
