import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentWritten } = await import('./document-written.js')
const documentWritten = createDocumentWritten()
const { saveDocument } = await import('./document-store.js')
const { getDb } = await import('./db/index.js')
const { prepareDataDir } = await import('./db/prepare.js')
const { documentFrontier, installAutoCheckpoint, uninstallAutoCheckpointForTests } = await import(
  './auto-checkpoint.js'
)
type CheckpointSubject = Parameters<import('./auto-checkpoint.js').DocumentCheckpointScheduler>[2]
const { documentStoreReady } = await import('./store-handles.js')
const { _autoCompactTimerCountForTests, disposeAutoCompact, uninstallAutoCompact } = await import(
  './auto-compact.js'
)

describe('documentWritten', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-written-'))
  })

  afterEach(async () => {
    uninstallAutoCheckpointForTests()
    await disposeAutoCompact()
    await rm(tempDir, { recursive: true, force: true })
  })

  // The observable effect, asserted on the scheduler rather than on the
  // observer returning: "it did not throw" is exactly the proxy indicator
  // that let the original gap survive.
  it('schedules a compaction for the document an agent write names', async () => {
    await saveDocument('01ZVM89A4A1V9FS03Z9J64KEK1', 'agent-written', new LoroDoc())
    const { resolveDocumentIdAtPath } = await import('./document-store.js')
    const documentId = await resolveDocumentIdAtPath('01ZVM89A4A1V9FS03Z9J64KEK1', 'agent-written')
    expect(documentId).not.toBeNull()
    if (documentId === null) throw new Error('unreachable')

    // Asserted, not merely captured: `toBe(1)` below only proves the observer
    // scheduled something if nothing was scheduled already. Creating the
    // document IS a write, and a second schedule for the same document
    // replaces the timer rather than adding one, so a count of 1 going in
    // would make the assertion say nothing. Measured as 0 here — this line
    // is what keeps it that way.
    expect(_autoCompactTimerCountForTests()).toBe(0)

    await documentWritten({
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
      documentId,
    })

    expect(_autoCompactTimerCountForTests()).toBe(1)
  })

  // End to end through the REAL tool and the REAL container, because the
  // defect was never in the observer — it was that nothing called one. A
  // test that only exercises documentWritten directly would have passed
  // throughout the entire time agent writes triggered no compaction.
  it('a real wb_canvas_edit through the real container schedules one', async () => {
    const { createContainer, resolveServerDeps } = await import('../../di/container.js')
    const { createSelfHostStoreLocalModule } = await import('../../di/store-local.module.js')
    const { wbDocumentCreate, createCanvasEditTool } = await import(
      '@kamiazya/whiteboard-server-core'
    )

    // The other tests reach the schema through saveDocument's own dbReady();
    // this one talks to the container directly, so it has to migrate first.
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tempDir)))
    // Registered explicitly: `createWorkspace: true` is ADR-0019's MINT
    // boundary, and a mint would key the workspace by a fresh ULID,
    // never by the id the store reads below address.
    await deps.documentIndex.createWorkspace({ workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1' })
    const created = await wbDocumentCreate(deps, {
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
      path: 'agent-edited',
      kind: 'spatial',
    })

    // Creating is a write too, so it has already scheduled one — and a
    // second schedule for the SAME document replaces that timer rather than
    // adding one, so counting alone cannot tell the edit's schedule from the
    // create's. Clear first, and the count can then only come from the edit.
    uninstallAutoCompact()
    expect(_autoCompactTimerCountForTests()).toBe(0)

    await createCanvasEditTool(deps).execute({
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
      documentId: created.documentId,
      ops: [
        {
          op: 'node.add',
          node: { id: 'n1', type: 'text', text: 'hi', x: 0, y: 0, width: 80, height: 40 },
        },
      ],
    })

    expect(_autoCompactTimerCountForTests()).toBe(1)
  })

  // The scheduler is keyed by workspace, so the id does not have to resolve
  // to anything: a write for an id the tree has no placement for still grew
  // the workspace record, and that record is what gets compacted. Nothing
  // here opens the workspace doc to find out, which is the lookup this
  // observer used to make on every agent write.
  it('schedules for the workspace without resolving the id to a placement', async () => {
    await saveDocument('01ZVM89A4A1V9FS03Z9J64KEK1', 'seeded', new LoroDoc())
    uninstallAutoCompact()
    expect(_autoCompactTimerCountForTests()).toBe(0)

    await expect(
      documentWritten({
        workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    ).resolves.toBeUndefined()

    expect(_autoCompactTimerCountForTests()).toBe(1)
  })

  // The checkpoint is per document and addressed by path, so that is what the
  // seam hands over; the state it would record is the record's frontier, which
  // the signal carries as a read of the keeper rather than as a copy.
  it('signals the installed checkpoint scheduler with the path and the record frontier the keeper holds', async () => {
    await saveDocument('01ZVM89A4A1V9FS03Z9J64KEK1', 'agent-written', new LoroDoc())
    const signalled: { workspaceId: string; path: string; subject: CheckpointSubject }[] = []
    installAutoCheckpoint(
      Object.assign(
        (workspaceId: string, path: string, subject: CheckpointSubject) => {
          signalled.push({ workspaceId, path, subject })
        },
        {
          flush: async () => undefined,
          stop: () => undefined,
          moved: () => undefined,
          removed: () => undefined,
        },
      ),
    )

    await documentWritten({
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'agent-written',
    })

    expect(signalled.map(({ workspaceId, path }) => ({ workspaceId, path }))).toEqual([
      { workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1', path: 'agent-written' },
    ])
    const stored = await (await documentStoreReady()).readFrontier({
      docRef: { kind: 'workspace-tree', workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1' },
    })
    expect(stored).not.toBeNull()
    expect(await documentFrontier(signalled[0]?.subject as CheckpointSubject)).toEqual(
      stored?.frontier,
    )
  })

  it('never reads one frontier twice for a workspace the keeper holds no record of', async () => {
    const signalled: CheckpointSubject[] = []
    installAutoCheckpoint(
      Object.assign(
        (_workspaceId: string, _path: string, subject: CheckpointSubject) => {
          signalled.push(subject)
        },
        {
          flush: async () => undefined,
          stop: () => undefined,
          moved: () => undefined,
          removed: () => undefined,
        },
      ),
    )

    await documentWritten({
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'nowhere',
    })

    const first = await documentFrontier(signalled[0] as CheckpointSubject)
    const second = await documentFrontier(signalled[0] as CheckpointSubject)
    expect(first).not.toEqual(second)
  })

  // A document the index does not place has no path to checkpoint under;
  // the compaction half still runs.
  it('takes no checkpoint for a write the index does not place, and still schedules compaction', async () => {
    const signal = vi.fn()
    installAutoCheckpoint(
      Object.assign(signal, {
        flush: async () => undefined,
        stop: () => undefined,
        moved: () => undefined,
        removed: () => undefined,
      }),
    )

    await documentWritten({
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })

    expect(signal).not.toHaveBeenCalled()
    expect(_autoCompactTimerCountForTests()).toBe(1)
  })
})
