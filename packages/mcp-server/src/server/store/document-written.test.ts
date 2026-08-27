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

const { documentWritten } = await import('./document-written.js')
const { saveDocument } = await import('./document-store.js')
const { getDb } = await import('./db/index.js')
const { prepareDataDir } = await import('./db/prepare.js')
const { _autoCompactTimerCountForTests, disposeAutoCompact, uninstallAutoCompact } = await import(
  './auto-compact.js'
)

describe('documentWritten', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-written-'))
  })

  afterEach(async () => {
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

    await documentWritten({ workspaceId: 'ws-1', documentId })

    expect(_autoCompactTimerCountForTests()).toBe(1)
  })

  // End to end through the REAL tool and the REAL container, because the
  // defect was never in the observer — it was that nothing called one. A
  // test that only exercises documentWritten directly would have passed
  // throughout the entire time agent writes triggered no compaction.
  it('a real wb_canvas_edit through the real container schedules one', async () => {
    const { createContainer, resolveServerDeps } = await import('../../di/container.js')
    const { createStoreLocalModule } = await import('../../di/store-local.module.js')
    const { wbDocumentCreate, createCanvasEditTool } = await import(
      '@kamiazya/whiteboard-server-core'
    )

    // The other tests reach the schema through saveDocument's own dbReady();
    // this one talks to the container directly, so it has to migrate first.
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    const deps = resolveServerDeps(
      createContainer(createStoreLocalModule({ db, blobDir: tempDir })),
    )
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'agent-edited',
      kind: 'spatial',
      createWorkspace: true,
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

  // A tool can save bytes for an id the tree has never been told about.
  // There is nothing to compact under a name that does not exist, and that
  // must not throw into the write that just succeeded.
  it('does nothing for a documentId with no tree placement', async () => {
    await saveDocument('ws-1', 'seeded', new LoroDoc())
    const before = _autoCompactTimerCountForTests()

    await expect(
      documentWritten({ workspaceId: 'ws-1', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).resolves.toBeUndefined()

    expect(_autoCompactTimerCountForTests()).toBe(before)
  })
})
