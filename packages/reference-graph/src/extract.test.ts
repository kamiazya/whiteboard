import {
  readDocumentContent,
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { fileNode, groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { extractContentFacts, splitBearerTags, tagBearersOf } from './extract.js'

function docWith(kind: 'spatial' | 'markdown' | undefined): LoroDoc {
  const doc = new LoroDoc()
  if (kind !== undefined) writeDocumentKind(doc, kind)
  writeMarkdownBody(doc, 'see [[from-the-body]]')
  writeSpatialCanvas(doc, {
    nodes: [
      textNode({ id: 'n', x: 0, y: 0, width: 10, height: 10, text: 'see [[from-the-canvas]]' }),
    ],
    edges: [],
  })
  return doc
}

const targetsOf = (entryKind: 'spatial' | 'markdown' | undefined, doc: LoroDoc) =>
  extractContentFacts({ kind: entryKind }, doc).refs.map((ref) => ref.target)

describe('extractContentFacts chooses the half a document is read as', () => {
  it('trusts the kind the document records over the index row, as readDocumentContent does', () => {
    expect(targetsOf('spatial', docWith('markdown'))).toEqual(['from-the-body'])
    expect(targetsOf('markdown', docWith('spatial'))).toEqual(['from-the-canvas'])
  })

  it('falls back to the index row for a document that records no kind', () => {
    expect(targetsOf('markdown', docWith(undefined))).toEqual(['from-the-body'])
    expect(targetsOf('spatial', docWith(undefined))).toEqual(['from-the-canvas'])
  })

  it('reads a document that names no kind anywhere as a canvas, the kind every pre-kind document was', () => {
    expect(targetsOf(undefined, docWith(undefined))).toEqual(['from-the-canvas'])
  })
})

describe('extractContentFacts texts', () => {
  it('lead with the description a markdown document records, so the daemon indexes it', () => {
    const doc = docWith('markdown')
    writeCoreFacets(doc, { type: 'note', description: 'Quarterly zebracrossing summary' })
    expect(extractContentFacts({ kind: 'markdown' }, doc).texts).toEqual([
      'Quarterly zebracrossing summary',
      'see [[from-the-body]]',
    ])
  })
})

describe('what a document bears', () => {
  const board = (): LoroDoc => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      tags: ['team:core'],
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'a', tags: ['health:ok'] }),
        textNode({ id: 'b', x: 20, y: 0, width: 10, height: 10, text: 'b', tags: ['health:ok'] }),
        textNode({ id: 'plain', x: 40, y: 0, width: 10, height: 10, text: 'plain' }),
      ],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, tags: ['link:slow'] }],
    })
    return doc
  }

  it('names a board, each box and each edge that carries a tag, and nothing that carries none', () => {
    const doc = board()
    const bearers = tagBearersOf(doc, readDocumentContent(doc, 'spatial'))
    expect(bearers.map(({ what, id, tags }) => ({ what, id, tags }))).toEqual([
      { what: 'board', id: undefined, tags: ['team:core'] },
      { what: 'node', id: 'a', tags: ['health:ok'] },
      { what: 'node', id: 'b', tags: ['health:ok'] },
      { what: 'edge', id: 'e', tags: ['link:slow'] },
    ])
  })

  it('names a note by its frontmatter tags, and a note with none bears nothing', () => {
    const tagged = new LoroDoc()
    writeCoreFacets(tagged, { type: 'note', tags: ['q3'] })
    expect(
      tagBearersOf(tagged, readDocumentContent(tagged, 'markdown')).map((b) => b.what),
    ).toEqual(['document'])
    const bare = new LoroDoc()
    expect(tagBearersOf(bare, readDocumentContent(bare, 'markdown'))).toEqual([])
  })

  it('splits a board into its own tags and what its boxes and edges carry, deduplicated', () => {
    const doc = board()
    expect(splitBearerTags(tagBearersOf(doc, readDocumentContent(doc, 'spatial')))).toEqual({
      own: ['team:core'],
      carried: ['health:ok', 'link:slow'],
    })
  })

  it('answers nothing for a document that bears nothing', () => {
    expect(splitBearerTags([])).toEqual({ own: [], carried: [] })
  })
})

const TAGGED = ['t:1']
const geo = { x: 0, y: 0, width: 10, height: 10 }

function bearersOfCanvas(canvas: Parameters<typeof writeSpatialCanvas>[1]) {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return tagBearersOf(doc, readDocumentContent(doc, 'spatial'))
}

describe('what a tag bearer is called in an excerpt', () => {
  it('a text box by its text, a labelled frame by its label, anything nameless by its id', () => {
    const bearers = bearersOfCanvas({
      nodes: [
        textNode({ id: 'say', ...geo, text: 'Hello', tags: TAGGED }),
        groupNode({ id: 'frame', ...geo, label: 'Zone A', tags: TAGGED }),
        groupNode({ id: 'bare-frame', ...geo, tags: TAGGED }),
        textNode({ id: 'empty-text', ...geo, text: '', tags: TAGGED }),
        fileNode({ id: 'doc-ref', ...geo, file: 'some/note', tags: TAGGED }),
      ],
      edges: [],
    })
    expect(Object.fromEntries(bearers.map((b) => [b.id, b.text]))).toEqual({
      say: 'Hello',
      frame: 'Zone A',
      'bare-frame': 'bare-frame',
      'empty-text': 'empty-text',
      'doc-ref': 'doc-ref',
    })
  })

  it('an edge by its label, else by the names of its two ends, an unknown end by its id', () => {
    const bearers = bearersOfCanvas({
      nodes: [
        textNode({ id: 'a', ...geo, text: 'Alpha' }),
        groupNode({ id: 'g', ...geo, label: 'Zone' }),
      ],
      edges: [
        { id: 'e1', from: { node: 'a' }, to: { node: 'g' }, label: 'depends on', tags: TAGGED },
        { id: 'e2', from: { node: 'a' }, to: { node: 'g' }, tags: TAGGED },
        { id: 'e3', from: { node: 'a' }, to: { node: 'ghost' }, label: '', tags: TAGGED },
      ],
    })
    expect(Object.fromEntries(bearers.map((b) => [b.id, b.text]))).toEqual({
      e1: 'depends on',
      e2: 'Alpha → Zone',
      e3: 'Alpha → ghost',
    })
  })
})
