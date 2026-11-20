import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeCommentThread } from '../comment-threads.js'
import { writeFacets } from '../document-envelope.js'
import { writeSpatialNode } from '../loro-bridge.js'
import { writeMarkdownBody } from '../markdown-body.js'
import {
  createWorkspaceDocument,
  documentContainers,
  projectWorkspaceDocument,
} from '../workspace-tree.js'
import { createCrdtEngine } from './engine.js'
import { exportProjection, ownedLease } from './lease.js'

const IDS = [
  '01J0000000000000000000000A',
  '01J0000000000000000000000B',
  '01J0000000000000000000000C',
]

/** A record holding a spatial board and two notes, each with content of its own. */
function record(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocument(doc, { documentId: IDS[0] as string, segment: 'board', kind: 'spatial' })
  createWorkspaceDocument(doc, { documentId: IDS[1] as string, segment: 'one', kind: 'markdown' })
  createWorkspaceDocument(doc, { documentId: IDS[2] as string, segment: 'two', kind: 'markdown' })
  writeSpatialNode(documentContainers(doc, IDS[0] as string), {
    id: 'n',
    resource: { mimeType: 'text/markdown', content: 'box' },
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  })
  writeFacets(documentContainers(doc, IDS[0] as string), { 'visual.test/v1': { tone: 'warm' } })
  writeMarkdownBody(documentContainers(doc, IDS[1] as string), 'first body')
  writeMarkdownBody(documentContainers(doc, IDS[2] as string), 'second body')
  writeCommentThread(documentContainers(doc, IDS[2] as string), {
    id: 't',
    anchor: { kind: 'canvas', x: 1, y: 1 },
    status: 'open',
    messages: [{ id: 'm', authorId: 'a', body: 'hi', createdAt: 1 }],
    createdAt: 1,
  } as never)
  doc.commit()
  return doc
}

function engineProjection(source: LoroDoc, documentId: string): LoroDoc | null {
  const engine = createCrdtEngine()
  const { handle } = engine.open({
    peer: '1',
    bytes: Buffer.from(source.export({ mode: 'snapshot' })).toString('base64'),
  })
  const bytes = exportProjection(ownedLease(engine, handle), documentId)
  if (bytes === null) return null
  const opened = new LoroDoc()
  opened.import(bytes)
  return opened
}

describe('the engine projection export', () => {
  it.each(IDS)('opens to what projectWorkspaceDocument gives for %s', (id) => {
    const source = record()
    const expected = projectWorkspaceDocument(source, id)?.toJSON()
    expect(expected).toBeDefined()
    expect(engineProjection(source, id)?.toJSON()).toEqual(expected)
  })

  it('answers none for an id the record does not hold', () => {
    expect(engineProjection(record(), '01J0000000000000000000000Z')).toBeNull()
  })

  it('is built fresh, so its bytes are not promised equal across calls', () => {
    // Pinned so a reader who assumes byte equality finds it is not given.
    const source = record()
    const engine = createCrdtEngine()
    const { handle } = engine.open({
      peer: '1',
      bytes: Buffer.from(source.export({ mode: 'snapshot' })).toString('base64'),
    })
    const lease = ownedLease(engine, handle)
    const a = exportProjection(lease, IDS[1] as string)
    const b = exportProjection(lease, IDS[1] as string)
    expect(Buffer.from(a as Uint8Array).equals(Buffer.from(b as Uint8Array))).toBe(false)
  })
})
