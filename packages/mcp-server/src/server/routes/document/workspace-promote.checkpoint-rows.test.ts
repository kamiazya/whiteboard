/**
 * The version rows a promote leaves: one explicit checkpoint per promoted
 * document, each naming the document, the operator, how many nodes the state
 * holds and the digest of its content, all at the one frontier the merged
 * record stands at. A document the merge shadowed gets none and is answered as
 * shadowed; one at its manual ceiling is left out of `recorded` without failing
 * the rest.
 */
import '../../store/_test-loro-records.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_MANUAL_PER_DOCUMENT } from '@kamiazya/whiteboard-history'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readWorkspaceDocuments,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { promoteWorkspace, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveTestServerDeps, seedWorkspaceRow } from '../_test-helpers.js'

let tempDir: string
let serverDeps: ServerDeps
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { _clearWorkspaceDocCacheForTests, getWorkspaceDoc } = await import(
  '../../store/document-store.js'
)
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')
const { getDb } = await import('../../store/db/index.js')

const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'
const ids = {
  noteA: '01BRWAAAAAAAAAAAAAAAAAAAB0',
  noteB: '01BRWAAAAAAAAAAAAAAAAAAAB1',
  board: '01BRWAAAAAAAAAAAAAAAAAAAB2',
  emptyBoard: '01BRWAAAAAAAAAAAAAAAAAAAB3',
  twin: '01BRWAAAAAAAAAAAAAAAAAAAB4',
}

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'promote-rows-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  _clearWorkspaceDocCacheForTests()
  await seedWorkspaceRow(tempDir, WS)
  serverDeps = await resolveTestServerDeps(tempDir)
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function record(): Uint8Array {
  const doc = new LoroDoc()
  doc.setPeerId(2n)
  createWorkspaceDocumentAtPath(doc, { path: 'notes/a', documentId: ids.noteA, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, ids.noteA), '# A\n\nfirst')
  createWorkspaceDocumentAtPath(doc, { path: 'notes/b', documentId: ids.noteB, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, ids.noteB), '# B\n\nsecond')
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: ids.board, kind: 'spatial' })
  for (const id of ['n1', 'n2', 'n3']) {
    writeSpatialNode(
      documentContainers(doc, ids.board),
      textNode({ id, x: 0, y: 0, width: 10, height: 10, text: id }),
    )
  }
  createWorkspaceDocumentAtPath(doc, {
    path: 'empty-board',
    documentId: ids.emptyBoard,
    kind: 'spatial',
  })
  doc.commit()
  // The same path created concurrently by another peer: the merge keeps one owner
  // and shows the other as shadowed.
  const peer = new LoroDoc()
  peer.setPeerId(3n)
  createWorkspaceDocumentAtPath(peer, { path: 'notes/a', documentId: ids.twin, kind: 'markdown' })
  peer.commit()
  doc.import(peer.export({ mode: 'snapshot' }))
  return new Uint8Array(doc.export({ mode: 'snapshot' }))
}

const operator = { kind: 'human', displayName: 'Ada' } as const

it('leaves one manual row per owned document, at one frontier, with the digest and count of its state', async () => {
  const result = await promoteWorkspace(serverDeps, {
    workspaceId: WS,
    snapshot: record(),
    operator,
  })
  if (result.kind !== 'promoted') throw new Error(`not promoted: ${result.kind}`)

  const held = readWorkspaceDocuments(await getWorkspaceDoc(WS))
  const owned = held.filter((entry) => entry.shadowed !== true)
  const shadowedIds = held
    .filter((entry) => entry.shadowed === true)
    .map((entry) => entry.documentId)
  expect(shadowedIds).toHaveLength(1)
  expect(result.shadowed).toEqual(shadowedIds)
  expect([...result.recorded].sort()).toEqual(owned.map((entry) => entry.documentId).sort())

  const rows = await (await getDb(tempDir)).selectFrom('versions').selectAll().execute()
  expect(rows.map((row) => row.documentId).sort()).toEqual(
    owned.map((entry) => entry.documentId).sort(),
  )
  const expectedCount: Record<string, number> = {
    [ids.noteA]: 0,
    [ids.noteB]: 0,
    [ids.board]: 3,
    [ids.emptyBoard]: 0,
  }
  for (const row of rows) {
    const entry = owned.find((candidate) => candidate.documentId === row.documentId)
    expect(row.workspaceId).toBe(WS)
    expect(row.auto).toBe(0)
    expect(row.label).toBeNull()
    expect(row.operatorKind).toBe('human')
    expect(row.operatorDisplayName).toBe('Ada')
    expect(row.contentDigest).toBe(entry?.contentDigest)
    expect(row.elementCount).toBe(expectedCount[row.documentId] ?? row.elementCount)
    expect(row.restoredFrom).toBeNull()
  }
  expect(expectedCount[ids.board]).toBe(
    rows.find((row) => row.documentId === ids.board)?.elementCount,
  )
  // No write lands between the checkpoints, so they all name the same state of the record.
  expect(new Set(rows.map((row) => row.frontiers)).size).toBe(1)
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
})

it('lists each promoted document its checkpoint by path, newest first', async () => {
  await promoteWorkspace(serverDeps, { workspaceId: WS, snapshot: record(), operator })
  for (const path of ['notes/b', 'board', 'empty-board']) {
    const listed = await serverDeps.versions.list(WS, path)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.auto).toBe(false)
    expect(listed[0]?.operator).toEqual(operator)
  }
})

it('leaves a document at its manual ceiling out of `recorded` and records the rest', async () => {
  // The merge has to land first so the ceiling document exists to be saved against.
  await promoteWorkspace(serverDeps, { workspaceId: WS, snapshot: record(), operator })
  for (let i = 1; i < MAX_MANUAL_PER_DOCUMENT; i++) {
    await serverDeps.versions.save(WS, 'board', { auto: false })
  }
  const second = await promoteWorkspace(serverDeps, {
    workspaceId: WS,
    snapshot: record(),
    operator,
  })
  if (second.kind !== 'promoted') throw new Error(`not promoted: ${second.kind}`)
  expect(second.recorded).not.toContain(ids.board)
  expect(second.recorded).toEqual(expect.arrayContaining([ids.noteA, ids.noteB, ids.emptyBoard]))
})

it('refuses a batch naming a document at a path the record does not show it at, and writes no row', async () => {
  await promoteWorkspace(serverDeps, { workspaceId: WS, snapshot: record(), operator })
  const rows = async () => (await getDb(tempDir)).selectFrom('versions').select('id').execute()
  const before = (await rows()).length

  await expect(
    serverDeps.versions.saveAll(
      WS,
      [
        { documentId: ids.noteB, path: 'notes/b' },
        { documentId: ids.board, path: 'not/where/it/is' },
      ],
      { auto: false },
    ),
  ).rejects.toThrow(/not/i)

  expect(await rows()).toHaveLength(before)
})
