import { NODE_LOCATION_MAX_CHARS, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, linkNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { DocumentContainers } from './containers.js'
import { writeSpatialCanvas, writeSpatialNode } from './loro-bridge.js'
import {
  importWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const BOX = { y: 0, width: 200, height: 60 }

const urlOf = (length: number) => {
  const head = 'https://example.com/'
  return head + 'a'.repeat(length - head.length)
}

const link = (url: string) => linkNode({ id: 'k', x: 0, ...BOX, url })
const file = (path: string, subpath?: string) =>
  fileNode({ id: 'f', x: 300, ...BOX, file: path, ...(subpath !== undefined && { subpath }) })

/** A workspace record holding one board: a link and a file reference. */
function record(stored: { url?: string; file?: string } = {}): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: DOC_ID, kind: 'spatial' })
  const canvas: SpatialCanvas = {
    nodes: [link(stored.url ?? 'https://example.com/'), file(stored.file ?? 'notes')],
    edges: [],
  }
  writeSpatialCanvas(documentContainers(doc, DOC_ID), canvas)
  doc.commit()
  return doc
}

function updateFrom(base: LoroDoc, edit: (board: DocumentContainers) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(documentContainers(client, DOC_ID))
  client.commit()
  return client.export({ mode: 'update', from })
}

/** Both keepers' verdicts, which must agree. */
function judged(base: LoroDoc, update: Uint8Array) {
  const imported = importWithinTextLimits(base.fork(), update).breach
  expect(syncTextLimitJudge(base)(update)).toEqual(imported)
  return imported
}

describe('a node location written through a sync update', () => {
  it('refuses a link URL past the location limit', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      writeSpatialNode(board, link(urlOf(NODE_LOCATION_MAX_CHARS + 1))),
    )
    expect(judged(base, update)).toEqual({
      shape: 'node-location',
      chars: NODE_LOCATION_MAX_CHARS + 1,
      nodeId: 'k',
      container: expect.any(String),
    })
  })

  it('refuses a file path past the location limit', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      writeSpatialNode(board, file('a'.repeat(NODE_LOCATION_MAX_CHARS + 1))),
    )
    expect(judged(base, update)).toMatchObject({ shape: 'node-location', nodeId: 'f' })
  })

  it('refuses a file subpath past the location limit', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      writeSpatialNode(board, file('notes', `#${'a'.repeat(NODE_LOCATION_MAX_CHARS)}`)),
    )
    expect(judged(base, update)).toMatchObject({
      shape: 'node-location',
      chars: NODE_LOCATION_MAX_CHARS + 1,
      nodeId: 'f',
    })
  })

  it('refuses the legacy url field a pre-resource peer would write', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      board.getMap('nodes').set('k', {
        id: 'k',
        type: 'link',
        x: 0,
        ...BOX,
        url: urlOf(NODE_LOCATION_MAX_CHARS + 1),
      }),
    )
    expect(judged(base, update)).toMatchObject({ shape: 'node-location', nodeId: 'k' })
  })

  it('takes a link URL of exactly the limit', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      writeSpatialNode(board, link(urlOf(NODE_LOCATION_MAX_CHARS))),
    )
    expect(judged(base, update)).toBeNull()
  })

  it('takes an edit of a URL stored past the limit that does not grow it', () => {
    const stored = urlOf(NODE_LOCATION_MAX_CHARS + 10)
    const base = record({ url: stored })
    const update = updateFrom(base, (board) =>
      writeSpatialNode(board, { ...link(stored.slice(0, -3)), color: '1' }),
    )
    expect(judged(base, update)).toBeNull()
  })

  it('refuses a location past the limit that a record holds into an empty document', () => {
    const long = record({ file: 'a'.repeat(NODE_LOCATION_MAX_CHARS + 1) })
    expect(
      importWithinTextLimits(new LoroDoc(), long.export({ mode: 'snapshot' })).breach,
    ).toMatchObject({ shape: 'node-location', nodeId: 'f' })
  })

  it('answers a location breach with its own refusal code', () => {
    expect(SYNC_TEXT_BREACH_CODES['node-location']).toBe('node_location_too_large')
  })
})
