/**
 * Compaction must not cut history a branch tip still needs.
 *
 * The workspace record's shallow-snapshot cut used to consider version rows
 * alone; a branch whose tip predates the workspace's earliest version lost
 * the history its checkout needs — Loro refuses a checkout before the
 * shallow start ("You cannot switch a document to a version before the
 * shallow history's start version"), so branch switch, file-gc's tip scan
 * and merge all break on that branch. Measured before fixing: the probe in
 * this file reproduced the refusal at the Loro level on first run.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectWorkspaceDocument, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { decodeFrontiers, encodeFrontiers, LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument, compactDocument, resolveDocumentIdAtPath, openWorkspaceDocIfStored } =
  await import('./document-store.js')
const { clearCache } = await import('./doc-cache.js')
const { createBranch } = await import('./branches-store.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'compact-branch-pin-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearCache()
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function canvasDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  })
  return doc
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

it('a branch tip older than every version row survives compaction and still checks out', async () => {
  const WS = 'ws-pin'
  await saveDocument(WS, 'doc', canvasDoc('branch-era content'), { kind: 'spatial' })

  // The branch tip pins THIS moment of the workspace record's history.
  const atBranch = await openWorkspaceDocIfStored(WS)
  expect(atBranch).not.toBeNull()
  if (atBranch === null) throw new Error('unreachable')
  const tipFrontiers = atBranch.frontiers()
  await createBranch(WS, 'doc', {
    name: 'old-work',
    initialTipFrontiers: base64(encodeFrontiers(tipFrontiers)),
  })

  // History moves on — enough edits that folding the delta log is a real
  // gain — then the workspace's ONLY version row, so the earliest version
  // frontier is AFTER the branch tip.
  for (let i = 0; i < 30; i++) {
    await saveDocument(WS, 'doc', canvasDoc(`later content ${'x'.repeat(200)} ${i}`), {
      kind: 'spatial',
      overwrite: true,
    })
  }
  const versionStore = new FileVersionStore()
  await versionStore.save(WS, 'doc', canvasDoc('later content'), { auto: false, label: 'only' })

  const result = await compactDocument(WS, 'doc', versionStore)
  expect(result.reason).toBe('ok')

  // A FRESH open of the stored record — the live cache keeps full history,
  // so only the reloaded bytes can show what compaction actually kept.
  const db = await getDb(tempDir)
  const stored = await new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)).open(WS)
  expect(stored).not.toBeNull()
  if (stored === null) throw new Error('unreachable')

  // The branch checkout file-gc and branch switch both perform. Before the
  // fix Loro throws: "You cannot switch a document to a version before the
  // shallow history's start version."
  const at = LoroDoc.fromSnapshot(stored.export({ mode: 'snapshot' }))
  at.checkout(decodeFrontiers(encodeFrontiers(tipFrontiers)))
  const documentId = await resolveDocumentIdAtPath(WS, 'doc')
  expect(documentId).not.toBeNull()
  if (documentId === null) throw new Error('unreachable')
  const projected = projectWorkspaceDocument(at, documentId)
  expect(projected).not.toBeNull()
})

it('a pre-fold branch tip from a foreign oplog is skipped, not fatal to compaction', async () => {
  // Before the collapse, a branch tip was captured from the per-document
  // LoroDoc — its frontiers name peers the workspace record's oplog has
  // never seen. The boot fold copies content by VALUE, so those frontiers
  // stay foreign forever, and `frontiersToVV` on the workspace doc throws
  // "Frontiers not found" for them. A row like that must not disable
  // compaction for the whole workspace: the branch it names cannot be
  // checked out on the workspace record regardless of what the cut keeps.
  const WS = 'ws-foreign-tip'
  await saveDocument(WS, 'doc', canvasDoc('current era'), { kind: 'spatial' })

  const legacyPerDocumentDoc = canvasDoc('legacy per-document era')
  legacyPerDocumentDoc.commit()
  await createBranch(WS, 'doc', {
    name: 'pre-fold',
    initialTipFrontiers: base64(encodeFrontiers(legacyPerDocumentDoc.frontiers())),
  })

  for (let i = 0; i < 30; i++) {
    await saveDocument(WS, 'doc', canvasDoc(`later ${'x'.repeat(200)} ${i}`), {
      kind: 'spatial',
      overwrite: true,
    })
  }
  const versionStore = new FileVersionStore()
  await versionStore.save(WS, 'doc', canvasDoc('later'), { auto: false, label: 'only' })

  const result = await compactDocument(WS, 'doc', versionStore)
  expect(result.reason).toBe('ok')
})

it('an empty tipFrontiers (a branch never written to) does not block compaction', async () => {
  const WS = 'ws-empty-tip'
  await saveDocument(WS, 'doc', canvasDoc('v1'), { kind: 'spatial' })
  // createBranch's default: no tip recorded yet.
  await createBranch(WS, 'doc', { name: 'fresh' })
  for (let i = 0; i < 30; i++) {
    await saveDocument(WS, 'doc', canvasDoc(`v2 ${'x'.repeat(200)} ${i}`), {
      kind: 'spatial',
      overwrite: true,
    })
  }
  const versionStore = new FileVersionStore()
  await versionStore.save(WS, 'doc', canvasDoc('v2'), { auto: false, label: 'only' })

  const result = await compactDocument(WS, 'doc', versionStore)
  expect(result.reason).toBe('ok')
})
