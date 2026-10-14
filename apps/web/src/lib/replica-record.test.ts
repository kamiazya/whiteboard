import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readEdgeLocks,
  readMarkdownBody,
  readNodeLocks,
  readSpatialCanvas,
  setNodeLock,
  writeCoreFacets,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { STENCIL_LIBRARY_PATH, VISUAL_STENCILS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { linkEntries, linkTitles } from './link-entries.js'
import {
  REPLICA_IMAGE_UNAVAILABLE,
  readReplicaContent,
  readReplicaLocks,
  replicaEntries,
  replicaReferenceGraph,
  replicaReferenceWire,
  replicaStencilLibrary,
  replicaTagsInUse,
  writeReplicaLock,
  writeReplicaMarkdown,
  writeReplicaSpatial,
} from './replica-record.js'

const MD = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const SP = '01ARZ3NDEKTSV4RRFFQ69G5FB2'
const LINKER = '01ARZ3NDEKTSV4RRFFQ69G5FB3'
const CACHED = 'asset:0b9a6c1e-1111-4222-8333-444455556666'
const UNCACHED = 'asset:0b9a6c1e-1111-4222-8333-777788889999'

function record(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes/plan', documentId: MD, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, MD), '# Plan')
  createWorkspaceDocumentAtPath(doc, { path: 'sketch', documentId: SP, kind: 'spatial' })
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/linker',
    documentId: LINKER,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(doc, LINKER), 'see [[notes/plan]]')
  doc.commit()
  return doc
}

describe('replica record', () => {
  it('lists its documents with the kind each carries', () => {
    const entries = replicaEntries(record())
    expect(entries.map((e) => [e.path, e.kind])).toEqual(
      expect.arrayContaining([
        ['notes/plan', 'markdown'],
        ['sketch', 'spatial'],
      ]),
    )
    expect(entries.every((e) => !('updatedAt' in e))).toBe(true)
  })

  it('reads a body or a canvas according to the entry kind', () => {
    const doc = record()
    expect(readReplicaContent(doc, { documentId: MD, kind: 'markdown' })).toEqual({
      kind: 'markdown',
      body: '# Plan',
    })
    expect(readReplicaContent(doc, { documentId: SP, kind: 'spatial' }).kind).toBe('spatial')
  })

  it('reads an entry with no kind as spatial, the kind every pre-kind document was', () => {
    // The daemon's readers answer a kind recorded nowhere the same way.
    const doc = record()
    expect(readReplicaContent(doc, { documentId: SP }).kind).toBe('spatial')
  })

  it('writes a body into the record, where a read finds it', () => {
    const doc = record()
    writeReplicaMarkdown(doc, MD, '# Plan, edited')
    expect(readMarkdownBody(documentContainers(doc, MD))).toBe('# Plan, edited')
  })

  it('writes a canvas change as a diff against the previous canvas', () => {
    const doc = record()
    const prev = readSpatialCanvas(documentContainers(doc, SP))
    const added = textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 40, text: 'hi' })
    writeReplicaSpatial(doc, SP, prev, { ...prev, nodes: [...prev.nodes, added] })
    expect(readSpatialCanvas(documentContainers(doc, SP)).nodes.map((n) => n.id)).toEqual(['n1'])
  })

  it("reads a canvas's locks from the record, and writes a toggle back into it", () => {
    const doc = record()
    setNodeLock(documentContainers(doc, SP), 'held', true)
    expect(readReplicaLocks(doc, SP)).toEqual({ nodes: new Set(['held']), edges: new Set() })

    writeReplicaLock(doc, SP, { node: 'held' }, false)
    writeReplicaLock(doc, SP, { edge: 'e1' }, true)
    expect([...readNodeLocks(documentContainers(doc, SP))]).toEqual([])
    expect([...readEdgeLocks(documentContainers(doc, SP))]).toEqual(['e1'])
    // Another document's locks are its own.
    expect(readReplicaLocks(doc, MD)).toEqual({ nodes: new Set(), edges: new Set() })
  })

  it('resolves what the selected document links to from the record alone', () => {
    const doc = record()
    const entries = replicaEntries(doc)
    const linkable = entries.map((e) => ({
      documentId: e.documentId,
      path: e.path,
      ...(e.kind === undefined ? {} : { kind: e.kind }),
    }))
    const selected = entries.find((e) => e.documentId === LINKER)
    if (selected === undefined) throw new Error('fixture lost its linker')
    const resolveAlias = createUniqueNameResolver(linkEntries(linkable))
    const wire = replicaReferenceWire({
      references: replicaReferenceGraph({ record: doc, entries, selected, resolveAlias }),
      resolveAlias,
      resolveTitle: linkTitles(linkable),
    })
    expect(JSON.stringify(wire)).toContain('# Plan')
  })

  it('draws a cached image, and labels one this device does not hold as unavailable', () => {
    const doc = record()
    const prev = readSpatialCanvas(documentContainers(doc, SP))
    const images = [CACHED, UNCACHED].map((file, i) =>
      fileNode({ id: `i${i}`, x: i * 120, y: 0, width: 100, height: 100, file }),
    )
    writeReplicaSpatial(doc, SP, prev, { ...prev, nodes: [...prev.nodes, ...images] })
    const entries = replicaEntries(doc)
    const selected = entries.find((e) => e.documentId === SP)
    if (selected === undefined) throw new Error('fixture lost its canvas')
    const linkable = entries.map((e) => ({ documentId: e.documentId, path: e.path }))
    const resolveAlias = createUniqueNameResolver(linkEntries(linkable))
    const references = replicaReferenceGraph({ record: doc, entries, selected, resolveAlias })
    expect(references.images).toEqual([CACHED, UNCACHED])

    const wire = replicaReferenceWire({
      references,
      resolveAlias,
      resolveTitle: linkTitles(linkable),
      images: new Map([[CACHED, 'blob:cached']]),
    })
    expect(new Map(wire.extras)).toEqual(
      new Map([
        [CACHED, { image: { href: 'blob:cached' } }],
        [UNCACHED, { label: REPLICA_IMAGE_UNAVAILABLE }],
      ]),
    )
  })

  it('adds no image extra while the cached images are still being read', () => {
    const doc = record()
    const prev = readSpatialCanvas(documentContainers(doc, SP))
    const image = fileNode({ id: 'i0', x: 0, y: 0, width: 100, height: 100, file: CACHED })
    writeReplicaSpatial(doc, SP, prev, { ...prev, nodes: [...prev.nodes, image] })
    const entries = replicaEntries(doc)
    const selected = entries.find((e) => e.documentId === SP)
    if (selected === undefined) throw new Error('fixture lost its canvas')
    const resolveAlias = createUniqueNameResolver(linkEntries([]))
    const wire = replicaReferenceWire({
      references: replicaReferenceGraph({ record: doc, entries, selected, resolveAlias }),
      resolveAlias,
      resolveTitle: linkTitles([]),
    })
    expect(wire.extras).toEqual([])
  })
})

describe("the replica's stencil library", () => {
  const STENCILS = '01ARZ3NDEKTSV4RRFFQ69G5FB9'
  const lakehouse = {
    displayName: 'Lakehouse',
    color: '3',
    facets: { 'visual.shape/v0': { kind: 'hexagon' } },
  }

  function withLibrary(facets: Record<string, unknown>): LoroDoc {
    const doc = record()
    createWorkspaceDocumentAtPath(doc, {
      path: STENCIL_LIBRARY_PATH,
      documentId: STENCILS,
      kind: 'markdown',
    })
    writeFacets(documentContainers(doc, STENCILS), facets)
    doc.commit()
    return doc
  }

  it('reads the stencils the document at the library path declares', () => {
    const doc = withLibrary({ [VISUAL_STENCILS_KEY]: { stencils: { lakehouse } } })
    expect(replicaStencilLibrary(doc, replicaEntries(doc))).toEqual({ lakehouse })
  })

  it('is empty for a replica without a library document', () => {
    const doc = record()
    expect(replicaStencilLibrary(doc, replicaEntries(doc))).toEqual({})
  })

  it('leaves out a stencil the schema refuses and keeps the rest', () => {
    const doc = withLibrary({
      [VISUAL_STENCILS_KEY]: { stencils: { lakehouse, broken: { color: 42 } } },
    })
    expect(replicaStencilLibrary(doc, replicaEntries(doc))).toEqual({ lakehouse })
  })
})

describe("the replica's tags in use", () => {
  it("lists every document's tags and its contents' once each, in code-unit order", () => {
    const doc = record()
    writeCoreFacets(documentContainers(doc, MD), { type: 'note', tags: ['zeta', 'drafted'] })
    writeCoreFacets(documentContainers(doc, LINKER), { type: 'note', tags: ['drafted'] })
    writeSpatialCanvas(documentContainers(doc, SP), {
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'a', tags: ['health:ok'] }),
        textNode({ id: 'b', x: 20, y: 0, width: 10, height: 10, text: 'b', tags: ['Drafted'] }),
      ],
      edges: [],
    })
    doc.commit()
    expect(replicaTagsInUse(doc, replicaEntries(doc))).toEqual([
      'Drafted',
      'drafted',
      'health:ok',
      'zeta',
    ])
  })

  it('is empty for a replica whose documents carry no tags', () => {
    const doc = record()
    expect(replicaTagsInUse(doc, replicaEntries(doc))).toEqual([])
  })
})
