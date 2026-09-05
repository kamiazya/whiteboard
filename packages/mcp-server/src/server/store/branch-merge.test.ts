import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSpatialNode, writeSpatialNode } from '@kamiazya/whiteboard-loro-adapter'
import { encodeFrontiers, LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSpatialDoc } from '../../shared/test-utils/spatial-doc.js'

// Declare first because vi.mock is hoisted.
let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { performBranchMerge } = await import('./branch-merge.js')
const { createBranch, loadDocumentBranches, saveDocumentBranches } = await import(
  './branches-store.js'
)
const branchesStore = await import('./branches-store.js')
const { saveDocument, loadDocument, workspaceFrontiersForPath } = await import(
  './document-store.js'
)
const { DocumentStoreWorkspaceDocs } = await import('@kamiazya/whiteboard-workspace-index')
const { clearCache } = await import('./doc-cache.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { _resetWorkspaceLocksForTests } = await import('./workspace-lock.js')
const { captureLogsForTests } = await import('../log.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

const SID = 'session1'
const PATH = 'canvas-a'

function createDeps() {
  return {
    versionStore: new FileVersionStore(),
    sendHeadChanged: vi.fn(),
  }
}

describe('performBranchMerge', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-branch-merge-test-'))
    handle = await createIsolatedDb({ dataDir: tempDir })
    clearCache()
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
    _resetWorkspaceLocksForTests()
    vi.restoreAllMocks()
  })

  it('dry run returns a pure preview and persists nothing', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'hi', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })
    const before = await loadDocumentBranches(SID, PATH)
    const saveSpy = vi.spyOn(deps.versionStore, 'save')

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'feature',
      into: 'main',
      dryRun: true,
    })

    expect(result.committed).toBe(false)
    expect(result.previewElements).toHaveLength(1)
    expect(result.previewElementCount).toBe(result.previewElements?.length)
    // previewDoc IS sourceDoc, so source mirrors preview exactly.
    expect(result.sourceElementCount).toBe(result.previewElementCount)
    expect(result.targetElementCount).toBe(1)

    // Nothing persisted.
    await expect(loadDocumentBranches(SID, PATH)).resolves.toEqual(before)
    expect(saveSpy).not.toHaveBeenCalled()
    expect(deps.sendHeadChanged).not.toHaveBeenCalled()
  })

  it('dry run counts include edges, not just nodes', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({
      nodes: [
        { id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'B', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [{ id: 'e1', fromNode: 'A', toNode: 'B' }],
    })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'feature',
      into: 'main',
      dryRun: true,
    })

    expect(result.previewElementCount).toBe(3)
    expect(result.targetElementCount).toBe(3)
    expect(result.sourceElementCount).toBe(3)
    expect(result.previewElements).toHaveLength(3)
  })

  it('commit with HEAD===into updates the tip, reconciles + broadcasts the live doc, and reports diffs', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })

    // Pin main to the A-only state so it stops tracking the live doc. Tips
    // are recorded the way app.ts's getCurrentFrontiers records them: as
    // WORKSPACE record frontiers, the one lineage branch history lives in.
    const mainOnlyTip = Buffer.from((await workspaceFrontiersForPath(SID, PATH))!).toString(
      'base64',
    )
    const state = await loadDocumentBranches(SID, PATH)
    const main = state.branches.find((b) => b.name === 'main')!
    main.tipFrontiers = mainOnlyTip
    await saveDocumentBranches(SID, PATH, state)

    // Add C on top and pin feature's tip to it, so feature diverges from
    // main's frozen A-only tip instead of tracking the live doc.
    const withC = await loadDocument(SID, PATH)
    writeSpatialNode(withC, { id: 'C', type: 'text', text: 'c', x: 0, y: 0, width: 10, height: 10 })
    await saveDocument(SID, PATH, withC, { overwrite: true })
    const featureTip = Buffer.from((await workspaceFrontiersForPath(SID, PATH))!).toString('base64')
    const afterAddC = await loadDocumentBranches(SID, PATH)
    const feature = afterAddC.branches.find((b) => b.name === 'feature')!
    feature.tipFrontiers = featureTip
    await saveDocumentBranches(SID, PATH, afterAddC)
    clearCache()

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'feature',
      into: 'main',
      dryRun: false,
    })

    expect(result.committed).toBe(true)
    expect(result.newElementIds).toEqual(['C'])
    expect(result.changedElementIds).toEqual([])
    expect(result.conflictElementIds).toEqual([])
    expect(result.preMergeVersionId).toMatch(/\S+/)
    // Fan-out is the workspace record's funnel now (the per-document
    // broadcast dep is retired); this fixture's live doc already holds C, so
    // the reconcile writes no new bytes and there is nothing to fan out —
    // funnel delivery for a real change is pinned by the restore-route and
    // ws-workspace-scope tests.
    expect(deps.sendHeadChanged).toHaveBeenCalledWith(SID, PATH, 'main')

    const after = await loadDocumentBranches(SID, PATH)
    const afterMain = after.branches.find((b) => b.name === 'main')!
    // main's tip was moved onto feature's tip.
    expect(afterMain.tipFrontiers).toBe(featureTip)
  })

  it('commit with HEAD===source switches HEAD, reports switchedHead, and reconciles the live doc', async () => {
    const deps = createDeps()
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const el = list.insertContainer(0, new LoroMap())
    el.set('id', 'rect-1')
    doc.commit()
    await saveDocument(SID, PATH, doc, { overwrite: true })

    const branch = await createBranch(SID, PATH, { name: 'feature' })
    expect(branch.tipFrontiers).toBe('')
    // Switch HEAD to feature.
    await branchesStore.setHead(SID, PATH, 'feature')

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'feature',
      into: 'main',
      dryRun: false,
    })

    expect(result.committed).toBe(true)
    expect(result.switchedHead).toEqual({ from: 'feature', to: 'main' })
    expect(deps.sendHeadChanged).toHaveBeenCalledWith(SID, PATH, 'main')
    const after = await loadDocumentBranches(SID, PATH)
    expect(after.head).toBe('main')
    // source !== main and source !== into, so feature is deleted.
    expect(result.deletedSource).toBe('feature')
    expect(after.branches.some((b) => b.name === 'feature')).toBe(false)
  })

  it('commit with HEAD on a third branch only rewrites the tip: no broadcast, no head switch', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })
    await createBranch(SID, PATH, { name: 'third' })
    await branchesStore.setHead(SID, PATH, 'third')

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'feature',
      into: 'main',
      dryRun: false,
    })

    expect(result.committed).toBe(true)
    // sendHeadChanged is only fired by the HEAD===into reconcile branch or the
    // switchedHead cleanup branch, neither of which applies here.
    expect(deps.sendHeadChanged).not.toHaveBeenCalled()
    const after = await loadDocumentBranches(SID, PATH)
    expect(after.head).toBe('third')
  })

  it('uninitialized source tip falls back to the live snapshot and never calls updateBranchTip', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    const branch = await createBranch(SID, PATH, { name: 'feature' })
    expect(branch.tipFrontiers).toBe('')
    const updateBranchTipSpy = vi.spyOn(branchesStore, 'updateBranchTip')

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'feature',
      into: 'main',
      dryRun: false,
    })

    expect(result.committed).toBe(true)
    expect(updateBranchTipSpy).not.toHaveBeenCalled()
  })

  it('deletes the source branch when it is neither main nor into', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({ nodes: [], edges: [] })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'feature',
      into: 'main',
      dryRun: false,
    })

    expect(result.deletedSource).toBe('feature')
    const after = await loadDocumentBranches(SID, PATH)
    expect(after.branches.some((b) => b.name === 'feature')).toBe(false)
  })

  it('does not delete the source branch when it is main', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({ nodes: [], edges: [] })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    // main has no live divergence, but merging main into a second branch
    // exercises the "source === main" branch of the deletion guard.
    await createBranch(SID, PATH, { name: 'second' })

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'main',
      into: 'second',
      dryRun: false,
    })

    expect(result.deletedSource).toBeUndefined()
    const after = await loadDocumentBranches(SID, PATH)
    expect(after.branches.some((b) => b.name === 'main')).toBe(true)
  })

  it('does not delete the source branch when source equals into', async () => {
    // source !== into is already enforced at the route layer, but the
    // extracted function's own guard is independently pinned here.
    const deps = createDeps()
    const doc = makeSpatialDoc({ nodes: [], edges: [] })
    await saveDocument(SID, PATH, doc, { overwrite: true })

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'main',
      into: 'main',
      dryRun: false,
    })

    expect(result.deletedSource).toBeUndefined()
  })

  it('records a pre-merge snapshot with the system/merge operator', async () => {
    const deps = createDeps()
    const doc = new LoroDoc()
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })
    const saveSpy = vi.spyOn(deps.versionStore, 'save')

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'feature',
      into: 'main',
      dryRun: false,
    })

    expect(saveSpy).toHaveBeenCalledWith(
      SID,
      PATH,
      expect.anything(),
      expect.objectContaining({
        auto: true,
        label: 'before merge: feature → main',
        branchName: 'main',
        operator: expect.objectContaining({ kind: 'system', displayName: 'merge' }),
      }),
    )
    expect(result.preMergeVersionId).toMatch(/\S+/)
  })

  it('swallows a pre-merge snapshot failure: merge still commits, preMergeVersionId is undefined, and a warning is logged', async () => {
    const deps = createDeps()
    vi.spyOn(deps.versionStore, 'save').mockRejectedValueOnce(new Error('disk full'))
    const doc = new LoroDoc()
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })
    const cap = captureLogsForTests('warning')

    try {
      const result = await performBranchMerge(deps, SID, PATH, {
        source: 'feature',
        into: 'main',
        dryRun: false,
      })

      expect(result.committed).toBe(true)
      expect(result.preMergeVersionId).toBeUndefined()
      expect(cap.records).toContainEqual(
        expect.objectContaining({ scope: 'merge', msg: 'pre-merge snapshot failed' }),
      )
    } finally {
      cap.restore()
    }
  })

  it('swallows a post-merge head-switch failure: committed true, switchedHead undefined, a warning is logged', async () => {
    const deps = createDeps()
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const el = list.insertContainer(0, new LoroMap())
    el.set('id', 'rect-1')
    doc.commit()
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })
    await branchesStore.setHead(SID, PATH, 'feature')
    vi.spyOn(branchesStore, 'setHead').mockImplementationOnce(async () => {
      throw new Error('setHead boom')
    })
    const cap = captureLogsForTests('warning')

    try {
      const result = await performBranchMerge(deps, SID, PATH, {
        source: 'feature',
        into: 'main',
        dryRun: false,
      })

      expect(result.committed).toBe(true)
      expect(result.switchedHead).toBeUndefined()
      expect(cap.records).toContainEqual(
        expect.objectContaining({ scope: 'merge', msg: 'post-merge head switch failed' }),
      )
    } finally {
      cap.restore()
    }
  })

  it('swallows a post-merge delete-source failure: committed true, deletedSource undefined, a warning is logged', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({ nodes: [], edges: [] })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })
    vi.spyOn(branchesStore, 'deleteBranch').mockImplementationOnce(async () => {
      throw new Error('deleteBranch boom')
    })
    const cap = captureLogsForTests('warning')

    try {
      const result = await performBranchMerge(deps, SID, PATH, {
        source: 'feature',
        into: 'main',
        dryRun: false,
      })

      expect(result.committed).toBe(true)
      expect(result.deletedSource).toBeUndefined()
      expect(cap.records).toContainEqual(
        expect.objectContaining({ scope: 'merge', msg: 'post-merge delete source failed' }),
      )
    } finally {
      cap.restore()
    }
  })

  it('throws BranchNotFoundError naming the workspace/path for an unknown source branch', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({ nodes: [], edges: [] })
    await saveDocument(SID, PATH, doc, { overwrite: true })

    await expect(
      performBranchMerge(deps, SID, PATH, { source: 'ghost', into: 'main', dryRun: false }),
    ).rejects.toMatchObject({
      name: 'BranchNotFoundError',
      message: expect.stringMatching(new RegExp(`ghost.*${SID}/${PATH}`)),
    })
  })

  it('throws BranchNotFoundError naming the workspace/path for an unknown into branch', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({ nodes: [], edges: [] })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })

    await expect(
      performBranchMerge(deps, SID, PATH, { source: 'feature', into: 'ghost', dryRun: false }),
    ).rejects.toMatchObject({
      name: 'BranchNotFoundError',
      message: expect.stringMatching(new RegExp(`ghost.*${SID}/${PATH}`)),
    })
  })

  it('rejects an invalid source tip without mutating branches (dry run)', async () => {
    const deps = createDeps()
    const doc = makeSpatialDoc({ nodes: [], edges: [] })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })
    const state = await loadDocumentBranches(SID, PATH)
    const feature = state.branches.find((b) => b.name === 'feature')!
    feature.tipFrontiers = 'not-a-valid-tip'
    await saveDocumentBranches(SID, PATH, state)
    const before = await loadDocumentBranches(SID, PATH)

    await expect(
      performBranchMerge(deps, SID, PATH, { source: 'feature', into: 'main', dryRun: true }),
    ).rejects.toThrow(/feature/)
    await expect(loadDocumentBranches(SID, PATH)).resolves.toEqual(before)
  })

  it('a no-op reconcile completes without error (fan-out is the funnel, fed only by real changes)', async () => {
    // HEAD===into with an INITIALIZED source tip pointing at the same state
    // as the live doc: reconcileLiveDocToPreview runs and writes no ops.
    // Under the retired per-document broadcast this exported a header-only
    // envelope; now the workspace record's save sees no new bytes and the
    // funnel stays quiet — the pin is that the merge still commits cleanly.
    const deps = createDeps()
    const doc = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })
    const state = await loadDocumentBranches(SID, PATH)
    const feature = state.branches.find((b) => b.name === 'feature')!
    feature.tipFrontiers = Buffer.from((await workspaceFrontiersForPath(SID, PATH))!).toString(
      'base64',
    )
    await saveDocumentBranches(SID, PATH, state)

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'feature',
      into: 'main',
      dryRun: false,
    })

    expect(result.committed).toBe(true)
  })

  it('still reports switchedHead when reconciliation fails AFTER the head switch persisted', async () => {
    // The head switch and the live-doc reconcile are separate effects:
    // setHeadPersist has already durably moved HEAD when reconciliation
    // throws, so the response reports the switch that DID happen (hiding it
    // would tell clients nothing changed when it durably did) and the
    // failure is a warning. Faithful to the pre-extraction inline behavior.
    const deps = createDeps()
    const doc = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    await saveDocument(SID, PATH, doc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })
    // Diverge feature from main so the cleanup-branch reconcile has real
    // bytes to broadcast — that broadcast is the injection point below.
    const state = await loadDocumentBranches(SID, PATH)
    const feature = state.branches.find((b) => b.name === 'feature')!
    const diverged = makeSpatialDoc({
      nodes: [
        { id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'B', type: 'text', text: 'b', x: 50, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    })
    await saveDocument(SID, PATH, diverged, { overwrite: true })
    feature.tipFrontiers = Buffer.from((await workspaceFrontiersForPath(SID, PATH))!).toString(
      'base64',
    )
    await saveDocumentBranches(SID, PATH, state)
    await branchesStore.setHead(SID, PATH, 'feature')
    // The failure injection point moves again, because branches moved onto
    // the record: the head switch is now itself a record SAVE, so rejecting
    // every save would fail the switch this case needs to have SUCCEEDED and
    // would test nothing. So the rejection is armed at the one moment
    // between the two — `sendHeadChanged`, which the cleanup calls after the
    // switch has persisted and before the reconcile. (HEAD is `feature` here
    // and the target is `main`, so the commit path's own `sendHeadChanged`
    // does not run; this is the only call.)
    const realSave = DocumentStoreWorkspaceDocs.prototype.save
    let failSaves = false
    vi.spyOn(DocumentStoreWorkspaceDocs.prototype, 'save').mockImplementation(async function (
      this: InstanceType<typeof DocumentStoreWorkspaceDocs>,
      ...args: Parameters<typeof realSave>
    ) {
      if (failSaves) throw new Error('save boom')
      return realSave.apply(this, args)
    })
    deps.sendHeadChanged.mockImplementation(() => {
      failSaves = true
    })
    const cap = captureLogsForTests('warning')

    try {
      const result = await performBranchMerge(deps, SID, PATH, {
        source: 'feature',
        into: 'main',
        dryRun: false,
      })

      expect(result.committed).toBe(true)
      expect(result.switchedHead).toEqual({ from: 'feature', to: 'main' })
      expect(cap.records).toContainEqual(
        expect.objectContaining({ scope: 'merge', msg: 'post-merge head switch failed' }),
      )
    } finally {
      cap.restore()
    }
  })

  it('surfaces a resurrected badge across a two-sided divergence in both badges and conflictElementIds', async () => {
    const deps = createDeps()
    const forkDoc = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    await saveDocument(SID, PATH, forkDoc, { overwrite: true })
    await createBranch(SID, PATH, { name: 'feature' })

    // Source side: a REPLICA of the workspace record (its own peer), forked
    // at the point where A is still alive, independently adding F — the
    // shape a second keeper's concurrent edit takes after the sync cutover.
    const { cloneStoredWorkspaceDoc, getWorkspaceDoc, saveWorkspaceDoc } = await import(
      './document-store.js'
    )
    const { resolveWorkspaceDocument, documentContainers, writeSpatialCanvas } = await import(
      '@kamiazya/whiteboard-loro-adapter'
    )
    const replica = (await cloneStoredWorkspaceDoc(SID))!
    replica.setPeerId('999')
    const entry = resolveWorkspaceDocument(replica, PATH)!
    const replicaFrom = replica.version()
    writeSpatialCanvas(documentContainers(replica, entry.documentId), {
      nodes: [
        { id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'F', type: 'text', text: 'f', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    })
    replica.commit()
    const sourceTip = Buffer.from(encodeFrontiers(replica.frontiers())).toString('base64')

    // Target side: this keeper continues and deletes A.
    const live = await loadDocument(SID, PATH)
    deleteSpatialNode(live, 'A')
    await saveDocument(SID, PATH, live, { overwrite: true })
    const mainTip = Buffer.from((await workspaceFrontiersForPath(SID, PATH))!).toString('base64')

    // The replica's concurrent edit arrives, exactly as the sync path
    // delivers it: imported into the live workspace document.
    const workspaceDoc = await getWorkspaceDoc(SID)
    workspaceDoc.import(replica.export({ mode: 'update', from: replicaFrom }))
    await saveWorkspaceDoc(SID, workspaceDoc)
    clearCache()

    const state = await loadDocumentBranches(SID, PATH)
    const main = state.branches.find((b) => b.name === 'main')!
    main.tipFrontiers = mainTip
    const feature = state.branches.find((b) => b.name === 'feature')!
    feature.tipFrontiers = sourceTip
    await saveDocumentBranches(SID, PATH, state)

    const result = await performBranchMerge(deps, SID, PATH, {
      source: 'feature',
      into: 'main',
      dryRun: false,
    })

    expect(result.badges).toContainEqual({ type: 'resurrected', elementId: 'A' })
    expect(result.conflictElementIds).toContain('A')
    expect(result.newElementIds?.sort()).toEqual(['A', 'F'])
  })
})
