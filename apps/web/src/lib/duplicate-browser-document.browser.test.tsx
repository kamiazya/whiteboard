/**
 * Duplicate through the browser's PRODUCTION index, on real IndexedDB: the
 * path every browser surface takes once a page holds `FoldingBrowserIndex`,
 * where the copy is one write to the workspace record. The jsdom suite beside
 * this covers the row-backed doubles a page test injects, which never reach
 * that operation.
 */
import {
  documentContainers,
  readMarkdownBody,
  resolveWorkspaceDocument,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { beforeEach, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { idbContentClock } from './browser-document-summary.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { duplicateBrowserDocument } from './duplicate-browser-document.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { LoroStore } from './loro-store.js'
import { loadDocumentContent } from './workspace-content.js'

claimIsolatedWhiteboardDb('duplicate-browser-document')

beforeEach(async () => {
  await clearWhiteboardDb()
})

async function seedRoadmap(index: FoldingBrowserIndex): Promise<void> {
  const workspaceId = getBrowserWorkspaceId()
  await index.createWorkspace({ workspaceId })
  await index.createDocument({
    workspaceId,
    path: 'notes/roadmap',
    kind: 'markdown',
    name: 'Roadmap',
  })
  const docs = new BrowserWorkspaceDocs()
  const record = await docs.open(workspaceId)
  const entry = record === null ? null : resolveWorkspaceDocument(record, 'notes/roadmap')
  if (record === null || entry === null) throw new Error('the seeded document is not in the record')
  writeMarkdownBody(documentContainers(record, entry.documentId), '# Roadmap\n\nship it')
  record.commit()
  await docs.save(workspaceId, record)
}

it('copies beside the source, named after it, with its content and a last-edited time', async () => {
  const index = new FoldingBrowserIndex()
  await seedRoadmap(index)

  const copy = await duplicateBrowserDocument({
    index,
    loro: new LoroStore(),
    clock: idbContentClock(),
    sourcePath: 'notes/roadmap',
  })

  expect(copy).toMatchObject({
    path: 'notes/roadmap-copy',
    name: 'Roadmap (copy)',
    kind: 'markdown',
  })
  // The listing clock was stamped: an unstamped copy reports the epoch.
  expect(copy.updatedAt).not.toBe(new Date(0).toISOString())
  const content = await loadDocumentContent(copy.documentId)
  expect(content === null ? null : readMarkdownBody(content)).toBe('# Roadmap\n\nship it')
})

// What only the keeper-side operation can promise: the copy's path is chosen
// inside the write that makes it, so two presses at once cannot both pick it.
it('lands two duplicates started together on two paths', async () => {
  const index = new FoldingBrowserIndex()
  await seedRoadmap(index)
  const duplicate = () =>
    duplicateBrowserDocument({
      index,
      loro: new LoroStore(),
      clock: idbContentClock(),
      sourcePath: 'notes/roadmap',
    })

  const copies = await Promise.all([duplicate(), duplicate()])

  expect(copies.map((copy) => copy.path).sort()).toEqual([
    'notes/roadmap-copy',
    'notes/roadmap-copy-2',
  ])
})
