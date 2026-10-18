/**
 * An operation on a container whose creating operation is not in its own
 * causal past. Loro takes it in: the container has no parent, so it has no
 * path, and every bound — each found by where its container sits — reads
 * past it. Once a later change attaches the container, a replay of the
 * history applies everything written into it; a live state that took the two
 * one at a time does not, so a judge reading that state finds the attached
 * map empty while every replica that loads the history gets the whole board.
 * And asking for the path of such a container traps the engine.
 *
 * Measured on loro-crdt 1.13.6: the update filling `cid:0@P:Map` imports
 * with nothing pending, `getPathToContainer` on it panics ("Parent is not
 * registered"), and after P's op 0 attaches it at a node's `nodes` the live
 * state reads 0 entries while a fresh import of the same history reads all
 * of them.
 */
import { CANVAS_MAX_NODES, DOCUMENT_MAX_OPEN_THREADS } from '@kamiazya/whiteboard-model'
import { type JsonChange, LoroDoc, LoroMap, type LoroTreeNode } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  importWithinTextLimits,
  judgeStateWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
/** The peer whose first op will create, and attach, the container. */
const P = '777'
/** The peer writing into it before it exists. */
const Q = '888'
const ORPHAN = `cid:0@${P}:Map` as const

function record(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: DOC_ID, kind: 'spatial' })
  doc.commit()
  return doc
}

function nodeData(doc: LoroDoc): LoroTreeNode['data'] {
  const node = doc
    .getTree('tree')
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === DOC_ID)
  if (node === undefined) throw new Error(`no node holds ${DOC_ID}`)
  return node.data
}

/** Q's change: `entries` writes into the container P has not created, depending on nothing. */
function fill(entries: number, value: (i: number) => unknown): Uint8Array {
  const change: JsonChange = {
    id: `0@${Q}`,
    timestamp: 0,
    deps: [],
    lamport: 0,
    msg: null,
    ops: Array.from({ length: entries }, (_, i) => ({
      container: ORPHAN,
      content: { type: 'insert', key: `k${i}`, value: value(i) },
      counter: i,
    })) as JsonChange['ops'],
  }
  const q = new LoroDoc()
  q.setPeerId(BigInt(Q))
  // A string, since the typed form has no spelling for uncompressed peer ids.
  q.importJsonUpdates(
    JSON.stringify({ schema_version: 1, start_version: {}, peers: null, changes: [change] }),
  )
  return q.export({ mode: 'update' })
}

/** P's op 0: a fresh map at the node's `key`, which is the container Q wrote into. */
function attach(base: LoroDoc, key: string): Uint8Array {
  const p = base.fork()
  p.setPeerId(BigInt(P))
  const from = p.oplogVersion()
  const attached = nodeData(p).setContainer(key, new LoroMap())
  p.commit()
  expect(attached.id).toBe(ORPHAN)
  return p.export({ mode: 'update', from })
}

const BOARDS = [
  {
    bound: 'canvas-size',
    key: 'nodes',
    entries: CANVAS_MAX_NODES + 1,
    value: (i: number) => ({ id: `k${i}` }),
  },
  {
    bound: 'open-threads',
    key: 'comments',
    entries: DOCUMENT_MAX_OPEN_THREADS + 1,
    value: (i: number) => ({ id: `k${i}`, body: 'x' }),
  },
] as const

describe('writes into a container whose creation is not in their causal past', () => {
  it.each(BOARDS)('are refused before the attach can carry them past $bound', ({
    entries,
    value,
  }) => {
    const doc = record()

    const { breach } = importWithinTextLimits(doc, fill(entries, value))

    expect(breach).toEqual({ shape: 'unattached-container', container: ORPHAN })
    expect(SYNC_TEXT_BREACH_CODES['unattached-container']).toBe('causal_gap')
  })

  it.each(BOARDS)('are refused by the browser keeper too ($bound)', ({ entries, value }) => {
    const doc = record()

    expect(syncTextLimitJudge(doc)(fill(entries, value))).toEqual({
      shape: 'unattached-container',
      container: ORPHAN,
    })
  })

  it.each(BOARDS)('a carried history holding them is refused when judged as a state ($bound)', ({
    key,
    entries,
    value,
  }) => {
    const doc = record()
    const base = doc.fork()
    doc.import(fill(entries, value))
    doc.import(attach(base, key))
    const replayed = new LoroDoc()
    replayed.import(doc.export({ mode: 'update' }))

    // What makes it an escape: the live state reads empty, the history does not.
    expect((nodeData(doc).get(key) as LoroMap).size).toBe(0)
    expect((nodeData(replayed).get(key) as LoroMap).size).toBe(entries)
    expect(judgeStateWithinTextLimits(doc)).toEqual({
      shape: 'unattached-container',
      container: ORPHAN,
    })
  })

  it('a container created and filled in one update is judged by its bound, not refused', () => {
    const doc = record()
    const client = doc.fork()
    const from = client.oplogVersion()
    const map = nodeData(client).setContainer('nodes', new LoroMap())
    for (let i = 0; i <= CANVAS_MAX_NODES; i += 1) map.set(`k${i}`, { id: `k${i}` })
    client.commit()

    expect(
      importWithinTextLimits(doc, client.export({ mode: 'update', from })).breach,
    ).toMatchObject({ shape: 'canvas-size', measure: 'nodes' })
  })

  it("another peer's write into a container it received is let through", () => {
    const doc = record()
    const writer = doc.fork()
    writer.setPeerId(BigInt(Q))
    const from = writer.oplogVersion()
    ;(nodeData(writer).get('nodes') as LoroMap).set('n1', { id: 'n1' })
    writer.commit()

    expect(importWithinTextLimits(doc, writer.export({ mode: 'update', from })).breach).toBeNull()
  })
})
