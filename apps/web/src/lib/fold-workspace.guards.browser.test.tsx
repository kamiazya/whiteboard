/**
 * The fold's never-adopt-twice guards, and the delta log it must not drop.
 *
 * Real IndexedDB and real Loro wasm: each guard answers a state only the real
 * stores produce — overlapping runs over one database, a tree saved before
 * its rows were retired, a record whose last edits live in its delta log.
 */

import {
  adoptWorkspaceDocument,
  documentContainers,
  readSpatialCanvas,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { Loro } from 'loro-crdt'
import { beforeEach, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { hasLegacyRow, seedLegacyRow as writeLegacyRow } from '../test-utils/seed-legacy-row.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { getAppLogger } from './app-logger.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { foldOrServeTheTree } from './fold-workspace.js'
import { LoroStore } from './loro-store.js'

const DB_NAME = claimIsolatedWhiteboardDb('fold-workspace-guards')

beforeEach(clearWhiteboardDb)

/** A completed run's report; a failed fold answers null, which no case here expects. */
async function fold() {
  const report = await foldOrServeTheTree(getAppLogger('fold-workspace.guards.test'), DB_NAME)
  if (report === null) throw new Error('the fold failed')
  return report
}

function canvasHolding(text: string): Loro {
  const doc = new Loro()
  doc.getMap('nodes').set('n1', textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text }))
  doc.commit()
  return doc
}

/** One legacy row and its per-document record, the way a pre-fold build wrote them. */
async function seedLegacyRow(path: string): Promise<{ documentId: string; doc: Loro }> {
  const entry = await writeLegacyRow(
    { workspaceId: getBrowserWorkspaceId(), path, kind: 'spatial' },
    DB_NAME,
  )
  const doc = canvasHolding(path)
  await new LoroStore(DB_NAME).save(entry.documentId, doc.export({ mode: 'snapshot' }))
  return { documentId: entry.documentId, doc }
}

async function treeDocumentIds(): Promise<string[]> {
  const workspace = await new BrowserWorkspaceDocs(DB_NAME).open(getBrowserWorkspaceId())
  return workspace === null ? [] : readWorkspaceDocuments(workspace).map((e) => e.documentId)
}

it('folds asked for at once adopt each legacy row exactly once', async () => {
  const seeded: string[] = []
  for (let i = 0; i < 4; i++) seeded.push((await seedLegacyRow(`d${i}`)).documentId)

  // The page, the switcher and the backend all ask on a cold start.
  const reports = await Promise.all([fold(), fold(), fold()])

  expect(reports).toEqual([
    { folded: 4, skipped: 0 },
    { folded: 4, skipped: 0 },
    { folded: 4, skipped: 0 },
  ])
  expect((await treeDocumentIds()).sort()).toEqual([...seeded].sort())
})

it('a row whose document the tree already holds is retired, not adopted a second time', async () => {
  const workspaceId = getBrowserWorkspaceId()
  const { documentId, doc } = await seedLegacyRow('design')
  // What a crash between the fold's save and its retirement leaves behind.
  const docs = new BrowserWorkspaceDocs(DB_NAME)
  const workspace = await docs.create(workspaceId)
  adoptWorkspaceDocument(workspace, { path: 'design', documentId, kind: 'spatial' }, doc)
  await docs.save(workspaceId, workspace)

  expect(await fold()).toEqual({ folded: 0, skipped: 0 })

  expect(await treeDocumentIds()).toEqual([documentId])
  expect((await new LoroStore(DB_NAME).load(documentId)).kind).toBe('not-found')
  expect(await hasLegacyRow({ workspaceId, documentId }, DB_NAME)).toBe(false)
})

it('folds the edits a legacy record holds only in its delta log', async () => {
  const { documentId } = await writeLegacyRow(
    { workspaceId: getBrowserWorkspaceId(), path: 'design', kind: 'spatial' },
    DB_NAME,
  )
  const doc = canvasHolding('snapshot')
  const snapshot = doc.export({ mode: 'snapshot' })
  const before = doc.oplogVersion()
  doc
    .getMap('nodes')
    .set('n2', textNode({ id: 'n2', x: 0, y: 80, width: 80, height: 40, text: 'from the log' }))
  doc.commit()
  const delta = doc.export({ mode: 'update', from: before })
  await seedSyncDocument(documentId, { snapshot, deltas: [delta] }, DB_NAME)

  expect(await fold()).toEqual({ folded: 1, skipped: 0 })

  const workspace = await new BrowserWorkspaceDocs(DB_NAME).open(getBrowserWorkspaceId())
  if (workspace === null) throw new Error('the fold saved no workspace record')
  const texts = readSpatialCanvas(documentContainers(workspace, documentId)).nodes.map(nodeText)
  expect(texts.sort()).toEqual(['from the log', 'snapshot'])
  // Retired: the tree is now the only copy, so the log's edit must be in it.
  expect((await new LoroStore(DB_NAME).load(documentId)).kind).toBe('not-found')
})
