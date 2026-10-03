import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  readSpatialCanvas,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { linkEntries, linkTitles } from './link-entries.js'
import {
  readReplicaContent,
  replicaEntries,
  replicaReferenceWire,
  writeReplicaMarkdown,
  writeReplicaSpatial,
} from './replica-record.js'

const MD = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const SP = '01ARZ3NDEKTSV4RRFFQ69G5FB2'
const LINKER = '01ARZ3NDEKTSV4RRFFQ69G5FB3'

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

  it('resolves what the selected document links to from the record alone', () => {
    const doc = record()
    const entries = replicaEntries(doc)
    const linkable = entries.map((e) => ({
      id: e.documentId,
      path: e.path,
      ...(e.kind === undefined ? {} : { kind: e.kind }),
    }))
    const selected = entries.find((e) => e.documentId === LINKER)
    if (selected === undefined) throw new Error('fixture lost its linker')
    const wire = replicaReferenceWire({
      record: doc,
      entries,
      selected,
      resolveAlias: createUniqueNameResolver(linkEntries(linkable)),
      resolveTitle: linkTitles(linkable),
    })
    expect(JSON.stringify(wire)).toContain('# Plan')
  })
})
