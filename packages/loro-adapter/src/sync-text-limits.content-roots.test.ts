/**
 * A document node's content keys each hold one container of the kind
 * `CONTENT_CONTAINER_KEYS` declares, and every reader and writer opens it
 * there. An update that leaves a scalar, a container of another kind, or
 * nothing at such a key makes the document unreadable to all of them, so the
 * judge both keepers take refuses it — judged by what the key holds once the
 * update is in, so a history that once held one and put it right passes.
 */
import { LoroDoc, LoroMap, LoroText, type LoroTreeNode } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  importWithinTextLimits,
  judgeStateWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
/** Past the length the browser keeper answers without importing, so both keepers judge it. */
const PADDING = 'p'.repeat(2_000)

type NodeData = LoroTreeNode['data']

function nodeData(doc: LoroDoc): NodeData {
  const node = doc
    .getTree('tree')
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === DOC_ID)
  if (node === undefined) throw new Error(`no node holds ${DOC_ID}`)
  return node.data
}

function record(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
  doc.commit()
  return doc
}

function updateFrom(base: LoroDoc, edit: (data: NodeData) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  const data = nodeData(client)
  ;(data.get('body') as LoroText).insert(0, PADDING)
  edit(data)
  client.commit()
  return client.export({ mode: 'update', from })
}

/** Both keepers' verdicts, which must agree. */
function judged(base: LoroDoc, update: Uint8Array) {
  const imported = importWithinTextLimits(base.fork(), update).breach
  expect(syncTextLimitJudge(base)(update)).toEqual(imported)
  return imported
}

const WRONG: ReadonlyArray<readonly [string, string, (data: NodeData) => void]> = [
  ['a scalar', 'nodes', (data) => data.set('nodes', 1)],
  ['a text where a map belongs', 'nodes', (data) => data.setContainer('nodes', new LoroText())],
  ['a map where a text belongs', 'body', (data) => data.setContainer('body', new LoroMap())],
  ['nothing', 'threads', (data) => data.delete('threads')],
]

describe('a content key left holding the wrong kind', () => {
  it.each(WRONG)('%s at a content key is refused', (_what, key, edit) => {
    const base = record()

    const breach = judged(base, updateFrom(base, edit))

    expect(breach).toEqual({ shape: 'content-root', key, container: nodeData(base).id })
    expect(SYNC_TEXT_BREACH_CODES['content-root']).toBe('invalid_document_root')
  })

  it('a fresh container of the declared kind is let through', () => {
    const base = record()

    expect(
      judged(
        base,
        updateFrom(base, (data) => data.setContainer('nodes', new LoroMap())),
      ),
    ).toBe(null)
  })

  it('a wrong value put right in the same update is let through', () => {
    const base = record()
    const update = updateFrom(base, (data) => {
      data.set('nodes', 1)
      data.setContainer('nodes', new LoroMap())
    })

    expect(judged(base, update)).toBe(null)
  })

  it('a key outside the content keys is not this judgement', () => {
    const base = record()

    expect(
      judged(
        base,
        updateFrom(base, (data) => data.set('currentBranch', 'main')),
      ),
    ).toBe(null)
  })

  it('a carried record holding one is refused when judged as a state', () => {
    const doc = record()
    nodeData(doc).set('nodes', 1)
    doc.commit()

    expect(judgeStateWithinTextLimits(doc)).toMatchObject({ shape: 'content-root', key: 'nodes' })
  })
})

it('a node created with a wrong-kind content key in the same update is refused', () => {
  // While the import replays, a node the update itself creates has no path yet.
  const base = new LoroDoc()
  base.getMap('elsewhere').set('k', 1)
  base.commit()
  const client = base.fork()
  const from = client.oplogVersion()
  createWorkspaceDocumentAtPath(client, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
  const data = nodeData(client)
  ;(data.get('body') as LoroText).insert(0, PADDING)
  data.set('nodes', 1)
  client.commit()

  expect(judged(base, client.export({ mode: 'update', from }))).toMatchObject({
    shape: 'content-root',
    key: 'nodes',
  })
})
