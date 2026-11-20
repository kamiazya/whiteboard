/**
 * The conformance cases for the removed-since export: the documents the
 * operations after a version took out of a workspace record, as a trash keeps
 * them. What matters is what a restore would bring back, so each case reads the
 * bytes as the record they are and judges the documents in them, never the
 * bytes themselves (they embed the peer that exported them).
 */
import { documentEngine as wire } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { CrdtEngine } from '../engine/types.js'
import { readWorkspaceDocuments } from '../workspace-tree.js'
import { ask, bytesOf, write } from './crdt-engine-conformance-kit.js'

const A = '01J000000000000000000000A1'
const B = '01J000000000000000000000B1'
const C = '01J000000000000000000000C1'

/** A record holding a document at each path, in order. */
function recordWith(engine: CrdtEngine, documents: ReadonlyArray<readonly [string, string]>) {
  const { handle } = engine.open({ peer: '5' })
  for (const [path, documentId] of documents) {
    write(engine, handle, 'createWorkspaceDocumentAtPath', { path, documentId, kind: 'markdown' })
  }
  return handle
}

const versionOf = (engine: CrdtEngine, handle: number) => engine.version({ handle }).version

function removedSince(engine: CrdtEngine, handle: number, since: wire.VersionEntry[]) {
  const { removed } = wire.exportResponseSchema.parse(
    engine.export({ handle, mode: 'removed-since', since }),
  )
  if (removed === undefined) throw new Error('a removed-since export answers the removed list')
  return removed
}

/** The ids of the documents in an evacuee's bytes, sorted. */
function documentIdsIn(bytes: string): string[] {
  const doc = new LoroDoc()
  doc.import(bytesOf(bytes))
  return readWorkspaceDocuments(doc)
    .map((entry) => entry.documentId)
    .sort()
}

async function liveIds(engine: CrdtEngine, handle: number): Promise<string[]> {
  const answer = (await ask(engine, handle, 'documents')) as {
    ok: Array<{ documentId: string }>
  }
  return answer.ok.map((entry) => entry.documentId).sort()
}

function describeRemovedBasics(makeEngine: () => CrdtEngine) {
  it('answers nothing for operations that removed nothing, even when they moved a document', () => {
    const engine = makeEngine()
    const handle = recordWith(engine, [
      ['one', A],
      ['two', B],
    ])
    const since = versionOf(engine, handle)
    write(engine, handle, 'moveWorkspaceNodeToPath', { from: 'one', to: 'three' })
    expect(removedSince(engine, handle, since)).toEqual([])
  })

  it('answers the removed document, its place and the names it had, with bytes that hold it', () => {
    const engine = makeEngine()
    const handle = recordWith(engine, [
      ['folder/other', A],
      ['folder/kept', B],
    ])
    write(engine, handle, 'setWorkspaceDocumentName', { documentId: A, name: 'Other' })
    write(engine, handle, 'setWorkspaceFolderName', { path: 'folder', name: 'Shelf' })
    const since = versionOf(engine, handle)
    write(engine, handle, 'deleteWorkspaceNodeAtPath', { path: 'folder/other' })
    const removed = removedSince(engine, handle, since)
    expect(removed.map(({ bytes: _bytes, ...rest }) => rest)).toEqual([
      {
        documentId: A,
        path: 'folder/other',
        name: 'Other',
        folderNames: [{ path: 'folder', name: 'Shelf' }],
      },
    ])
    expect(documentIdsIn(removed[0]?.bytes as string)).toEqual([A])
  })

  it('answers nothing for what was removed before the version it is asked from', () => {
    const engine = makeEngine()
    const handle = recordWith(engine, [
      ['one', A],
      ['two', B],
    ])
    write(engine, handle, 'deleteWorkspaceNodeAtPath', { path: 'one' })
    expect(removedSince(engine, handle, versionOf(engine, handle))).toEqual([])
  })
}

function describeRemovedNesting(makeEngine: () => CrdtEngine) {
  it('keeps a document below a removed one in that one bytes, with no entry of its own', () => {
    const engine = makeEngine()
    const handle = recordWith(engine, [
      ['a', A],
      ['a/b', B],
      ['c', C],
    ])
    const since = versionOf(engine, handle)
    write(engine, handle, 'deleteWorkspaceNodeAtPath', { path: 'a' })
    const removed = removedSince(engine, handle, since)
    expect(removed.map((entry) => entry.documentId)).toEqual([A])
    expect(documentIdsIn(removed[0]?.bytes as string)).toEqual([A, B])
  })

  it('leaves a survivor out of the bytes of the document it sat under', async () => {
    const engine = makeEngine()
    const handle = recordWith(engine, [
      ['a', A],
      ['a/b', B],
    ])
    const since = versionOf(engine, handle)
    write(engine, handle, 'moveWorkspaceNodeToPath', { from: 'a/b', to: 'kept' })
    write(engine, handle, 'deleteWorkspaceNodeAtPath', { path: 'a' })
    const removed = removedSince(engine, handle, since)
    expect(removed.map((entry) => entry.documentId)).toEqual([A])
    expect(documentIdsIn(removed[0]?.bytes as string)).toEqual([A])
    expect(await liveIds(engine, handle)).toEqual([B])
  })

  it('restores without a second copy of a survivor', async () => {
    const engine = makeEngine()
    const handle = recordWith(engine, [
      ['a', A],
      ['a/b', B],
    ])
    const since = versionOf(engine, handle)
    write(engine, handle, 'moveWorkspaceNodeToPath', { from: 'a/b', to: 'kept' })
    write(engine, handle, 'deleteWorkspaceNodeAtPath', { path: 'a' })
    const [evacuee] = removedSince(engine, handle, since)
    engine.importSubtree({ handle, bytes: evacuee?.bytes as string, judge: 'none' })
    expect(await liveIds(engine, handle)).toEqual([A, B])
  })
}

function describeRemovedOrder(makeEngine: () => CrdtEngine) {
  it('answers several removals deepest first', () => {
    const engine = makeEngine()
    const handle = recordWith(engine, [
      ['p', A],
      ['q/r', B],
      ['s', C],
    ])
    const since = versionOf(engine, handle)
    write(engine, handle, 'deleteWorkspaceNodeAtPath', { path: 'p' })
    write(engine, handle, 'deleteWorkspaceNodeAtPath', { path: 'q/r' })
    const removed = removedSince(engine, handle, since)
    expect(removed.map((entry) => entry.documentId)).toEqual([B, A])
    for (const entry of removed) expect(documentIdsIn(entry.bytes)).toEqual([entry.documentId])
  })
}

export function describeRemovedSinceExport(makeEngine: () => CrdtEngine) {
  describe('the removed-since export', () => {
    describeRemovedBasics(makeEngine)
    describeRemovedNesting(makeEngine)
    describeRemovedOrder(makeEngine)
  })
}
