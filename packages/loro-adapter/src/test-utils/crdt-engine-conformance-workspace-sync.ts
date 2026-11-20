/**
 * The conformance cases for `judge: 'workspace-sync'`: what a daemon's sync of
 * a workspace record refuses beyond the text limits. Each refusal keeps
 * nothing, so every case also reads the version the record holds afterwards.
 */
import {
  DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_PATH_MAX_LENGTH,
  WORKSPACE_MAX_DOCUMENTS,
  WORKSPACE_MAX_FOLDERS,
  type documentEngine as wire,
} from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeDocumentKind } from '../document-envelope.js'
import type { CrdtEngine } from '../engine/types.js'
import { createWorkspaceDocumentAtPath, documentContainers } from '../workspace-tree.js'
import { mutation } from './crdt-engine-conformance-kit.js'

export const NOTE = '01BRWAAAAAAAAAAAAAAAAAAAA0'
export const BOARD = '01BRWAAAAAAAAAAAAAAAAAAAB0'
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const CEILING_TIMEOUT_MS = 30_000

/** A record holding a note at `notes`, a board at `board` and a folder `week`. */
export function seedRecord(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: NOTE, kind: 'markdown' })
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: BOARD, kind: 'spatial' })
  createWorkspaceDocumentAtPath(doc, {
    path: 'week/plan',
    documentId: '01BRWAAAAAAAAAAAAAAAAAAAC0',
    kind: 'markdown',
  })
  doc.commit()
  return doc
}

/** `count` bare nodes: documents when `documents`, else folders. */
export function crowd(doc: LoroDoc, count: number, documents: boolean) {
  const tree = doc.getTree('tree')
  for (let i = 0; i < count; i++) {
    const node = tree.createNode()
    node.data.set('segment', `${documents ? 'd' : 'f'}${i}`)
    if (!documents) continue
    node.data.set('documentId', `01BRWC${String(i).padStart(20, '0')}`)
    node.data.set('kind', 'markdown')
    node.data.set('createdAt', 1_000)
    node.data.set('updatedAt', 1_000)
  }
}

/** The update a client holding `base` sends after `edit`. */
function updateFrom(base: LoroDoc, edit: (client: LoroDoc) => void): string {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return base64(client.export({ mode: 'update', from }))
}

const nodeOf = (doc: LoroDoc, match: (data: LoroMap) => boolean) => {
  const node = doc
    .getTree('tree')
    .getNodes()
    .find((candidate) => match(candidate.data))
  if (node === undefined) throw new Error('no such node')
  return node
}
export const documentNode = (doc: LoroDoc, documentId: string) =>
  nodeOf(doc, (data) => data.get('documentId') === documentId)
export const folderNode = (doc: LoroDoc, segment: string) =>
  nodeOf(doc, (data) => data.get('segment') === segment && data.get('documentId') === undefined)

type Judging = ReturnType<typeof judging>

function judging(makeEngine: () => CrdtEngine) {
  function hold(record: LoroDoc) {
    const engine = makeEngine()
    const { handle } = engine.open({
      peer: '1',
      bytes: base64(record.export({ mode: 'snapshot' })),
    })
    return { engine, handle }
  }
  function send(record: LoroDoc, edit: (client: LoroDoc) => void) {
    const { engine, handle } = hold(record)
    const before = engine.version({ handle }).encodedVersion
    const result = mutation(
      engine.import({ handle, bytes: updateFrom(record, edit), judge: 'workspace-sync' }),
    )
    const kept = engine.version({ handle }).encodedVersion === before ? 'nothing' : 'something'
    return { result, kept }
  }
  function refusedAs(record: LoroDoc, edit: (client: LoroDoc) => void, shape: wire.BreachShape) {
    const { result, kept } = send(record, edit)
    expect(result).toMatchObject({ outcome: 'refused', breach: { shape } })
    expect(kept).toBe('nothing')
  }
  return { hold, send, refusedAs }
}

function describeCeilings({ send, refusedAs }: Judging) {
  it('keeps an update that places a document and edits a name', () => {
    const record = seedRecord()
    const { result, kept } = send(record, (client) => {
      createWorkspaceDocumentAtPath(client, {
        path: 'more',
        documentId: '01BRWAAAAAAAAAAAAAAAAAAAD0',
        kind: 'markdown',
      })
      documentNode(client, NOTE).data.set('name', 'Notes')
    })
    expect(result.outcome).toBe('applied')
    expect(kept).toBe('something')
  })

  it(
    'refuses a record grown past the document ceiling, and one at it takes an edit adding none',
    () => {
      const record = new LoroDoc()
      crowd(record, WORKSPACE_MAX_DOCUMENTS, true)
      record.commit()
      refusedAs(record, (client) => crowd(client, 1, true), 'too-many-documents')
      expect(
        send(record, (client) =>
          documentNode(client, '01BRWC00000000000000000000').data.set('name', 'x'),
        ).result.outcome,
      ).toBe('applied')
    },
    CEILING_TIMEOUT_MS,
  )

  it(
    'refuses a record grown past the folder ceiling',
    () => {
      const record = new LoroDoc()
      crowd(record, WORKSPACE_MAX_FOLDERS, false)
      record.commit()
      refusedAs(record, (client) => crowd(client, 1, false), 'too-many-folders')
    },
    CEILING_TIMEOUT_MS,
  )
}

function describePlacement({ send, refusedAs }: Judging) {
  it('refuses a write that leaves a document node unreadable', () => {
    refusedAs(
      seedRecord(),
      (client) => documentNode(client, NOTE).data.set('kind', 'bogus'),
      'unreadable-document-meta',
    )
  })

  it('refuses a document or folder put at a path the grammar refuses', () => {
    refusedAs(
      seedRecord(),
      (client) => documentNode(client, NOTE).data.set('segment', 'not a segment'),
      'invalid-path',
    )
    refusedAs(
      seedRecord(),
      (client) => {
        let parent = client.getTree('tree').createNode()
        parent.data.set('segment', 'a')
        for (let level = 1; level < Math.ceil(DOCUMENT_PATH_MAX_LENGTH / 2) + 1; level++) {
          parent = parent.createNode()
          parent.data.set('segment', 'a')
        }
      },
      'invalid-path',
    )
  })

  it('takes an edit to a record that already holds a path the grammar refuses, until the edit moves one there', () => {
    const record = seedRecord()
    documentNode(record, NOTE).data.set('segment', 'not a segment')
    record.commit()
    const rename = (client: LoroDoc) => documentNode(client, BOARD).data.set('name', 'Board')
    expect(send(record, rename).result.outcome).toBe('applied')
    refusedAs(
      record,
      (client) => documentNode(client, BOARD).data.set('segment', 'also not one'),
      'invalid-path',
    )
  })
}

function describeNames({ refusedAs }: Judging) {
  it('refuses a document name grown past the bound', () => {
    refusedAs(
      seedRecord(),
      (client) =>
        documentNode(client, NOTE).data.set('name', 'x'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1)),
      'document-name-too-long',
    )
  })

  it('refuses a folder name the folder grammar refuses', () => {
    refusedAs(
      seedRecord(),
      (client) => folderNode(client, 'week').data.set('name', 'a/b'),
      'folder-name-refused',
    )
  })
}

function describeUpdate({ hold, send, refusedAs }: Judging) {
  it('refuses an envelope left saying another kind than its node records', () => {
    refusedAs(
      seedRecord(),
      (client) => writeDocumentKind(documentContainers(client, BOARD), 'markdown'),
      'document-kind-changed',
    )
  })

  it('refuses an update that builds on a change the record lacks, and keeps nothing of it', () => {
    const record = seedRecord()
    const client = record.fork()
    documentNode(client, NOTE).data.set('name', 'one')
    client.commit()
    const middle = client.oplogVersion()
    documentNode(client, NOTE).data.set('name', 'two')
    client.commit()
    const second = base64(client.export({ mode: 'update', from: middle }))
    const { engine, handle } = hold(record)
    const before = engine.version({ handle }).encodedVersion
    expect(
      mutation(engine.import({ handle, bytes: second, judge: 'workspace-sync' })),
    ).toMatchObject({ outcome: 'refused', breach: { shape: 'causal-gap' } })
    expect(engine.version({ handle }).encodedVersion).toBe(before)
  })

  it(
    'judges the text limits first, as the text judge does',
    () => {
      const record = seedRecord()
      const { result } = send(record, (client) => {
        createWorkspaceDocumentAtPath(client, {
          path: 'x'.repeat(4),
          documentId: '01BRWAAAAAAAAAAAAAAAAAAAE0',
          kind: 'markdown',
        })
        const body = documentContainers(client, '01BRWAAAAAAAAAAAAAAAAAAAE0').getText('body')
        body.insert(0, 'y'.repeat(2_000_000))
        // A second, independent refusal: judged the other way round, this
        // update would answer `invalid-path`.
        documentNode(client, NOTE).data.set('segment', 'not a segment')
      })
      expect(result).toMatchObject({ outcome: 'refused', breach: { shape: 'run' } })
    },
    CEILING_TIMEOUT_MS,
  )
}

function describePrecedence({ refusedAs }: Judging) {
  const unreadable = (client: LoroDoc) => documentNode(client, NOTE).data.set('kind', 'bogus')
  const offGrammar = (client: LoroDoc) => documentNode(client, BOARD).data.set('segment', 'not one')
  const longName = (client: LoroDoc) =>
    documentNode(client, BOARD).data.set('name', 'x'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1))
  const badFolderName = (client: LoroDoc) => folderNode(client, 'week').data.set('name', 'a/b')
  const wrongKind = (client: LoroDoc) =>
    writeDocumentKind(documentContainers(client, BOARD), 'markdown')

  // One update breaking two limits answers the first of them in the judge's
  // order, whatever order the edits were written in: a keeper's refusal must
  // not depend on which of two violations a peer happened to make first.
  it.each([
    [
      'an unreadable node over a path off the grammar',
      [offGrammar, unreadable],
      'unreadable-document-meta',
    ],
    ['a path off the grammar over a name past the bound', [longName, offGrammar], 'invalid-path'],
    [
      'a name past the bound over a refused folder name',
      [badFolderName, longName],
      'document-name-too-long',
    ],
    [
      'a kind an envelope contradicts over a path off the grammar',
      [offGrammar, wrongKind],
      'document-kind-changed',
    ],
  ] as const)('answers %s', (_competing, edits, shape) => {
    refusedAs(seedRecord(), (client) => edits.forEach((edit) => edit(client)), shape)
    refusedAs(seedRecord(), (client) => [...edits].reverse().forEach((edit) => edit(client)), shape)
  })
}

export function describeWorkspaceSyncJudging(makeEngine: () => CrdtEngine) {
  describe('what a workspace-sync judge refuses', () => {
    const judge = judging(makeEngine)
    describeCeilings(judge)
    describePlacement(judge)
    describeNames(judge)
    describeUpdate(judge)
    describePrecedence(judge)
  })
}
