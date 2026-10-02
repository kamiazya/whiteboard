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
const { installAutoCheckpoint, uninstallAutoCheckpoint } = await import('./auto-checkpoint.js')
const { _autoCompactTimerCountForTests, disposeAutoCompact, uninstallAutoCompact } = await import(
  './auto-compact.js'
)

describe('documentWritten', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-written-'))
  })

  afterEach(async () => {
    uninstallAutoCheckpoint()
    await disposeAutoCompact()
    await rm(tempDir, { recursive: true, force: true })
  })

  // The observable effect, asserted on the scheduler rather than on the
  // observer returning: "it did not throw" is exactly the proxy indicator
  // that let the original gap survive.
  it('schedules a compaction for the document an agent write names', async () => {
    await saveDocument('ws-1', 'agent-written', new LoroDoc())
    const { resolveDocumentIdAtPath } = await import('./document-store.js')
    const documentId = await resolveDocumentIdAtPath('ws-1', 'agent-written')
    expect(documentId).not.toBeNull()
    if (documentId === null) throw new Error('unreachable')

    // Asserted, not merely captured: `toBe(1)` below only proves the observer
    // scheduled something if nothing was scheduled already. Creating the
    // document IS a write, and a second schedule for the same document
    // replaces the timer rather than adding one, so a count of 1 going in
    // would make the assertion say nothing. Measured as 0 here — this line
    // is what keeps it that way.
    expect(_autoCompactTimerCountForTests()).toBe(0)

    await documentWritten({ workspaceId: 'ws-1', documentId, doc: new LoroDoc() })

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
    // boundary, and a mint would key the workspace by a fresh ULID with
    // `ws-1` as its segment — leaving the store reads below naming nothing.
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
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
      workspaceId: 'ws-1',
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
    await saveDocument('ws-1', 'seeded', new LoroDoc())
    uninstallAutoCompact()
    expect(_autoCompactTimerCountForTests()).toBe(0)

    await expect(
      documentWritten({
        workspaceId: 'ws-1',
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        doc: new LoroDoc(),
      }),
    ).resolves.toBeUndefined()

    expect(_autoCompactTimerCountForTests()).toBe(1)
  })

  // The checkpoint is per document and addressed by path, so what the seam
  // hands over is exactly what reaches the scheduler.
  it('signals the installed checkpoint scheduler with the path and doc it was handed', async () => {
    const signalled: { workspaceId: string; path: string; doc: LoroDoc }[] = []
    installAutoCheckpoint(
      Object.assign(
        (workspaceId: string, path: string, doc: LoroDoc) => {
          signalled.push({ workspaceId, path, doc })
        },
        { flush: async () => undefined, stop: () => undefined },
      ),
    )
    const doc = new LoroDoc()

    await documentWritten({
      workspaceId: 'ws-1',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'agent-written',
      doc,
    })

    expect(signalled).toEqual([{ workspaceId: 'ws-1', path: 'agent-written', doc }])
  })

  // A document the index does not place has no path to checkpoint under;
  // the compaction half still runs.
  it('takes no checkpoint for a write the index does not place, and still schedules compaction', async () => {
    const signal = vi.fn()
    installAutoCheckpoint(
      Object.assign(signal, { flush: async () => undefined, stop: () => undefined }),
    )

    await documentWritten({
      workspaceId: 'ws-1',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      doc: new LoroDoc(),
    })

    expect(signal).not.toHaveBeenCalled()
    expect(_autoCompactTimerCountForTests()).toBe(1)
  })
})
