/**
 * Duplicate through the browser's PRODUCTION index, on real IndexedDB: the
 * path every browser surface takes once a page holds `BrowserDocumentIndex`,
 * where the copy is one write to the workspace record.
 */
import {
  documentContainers,
  readCommentThreads,
  readMarkdownBody,
  resolveWorkspaceDocument,
  writeCommentThread,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { beforeEach, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserDocumentIndex } from './browser-document-index.js'
import { idbContentClock } from './browser-document-summary.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { duplicateBrowserDocument } from './duplicate-browser-document.js'
import { loadDocumentContent } from './workspace-content.js'

claimIsolatedWhiteboardDb('duplicate-browser-document')

beforeEach(async () => {
  await clearWhiteboardDb()
})

async function seedRoadmap(index: BrowserDocumentIndex): Promise<void> {
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
  const containers = documentContainers(record, entry.documentId)
  writeMarkdownBody(containers, '# Roadmap\n\nship it')
  writeCommentThread(containers, {
    id: 't1',
    anchor: { kind: 'document' },
    status: 'open',
    messages: [{ id: 'm1', body: 'which release?' }],
  })
  record.commit()
  await docs.save(workspaceId, record)
}

async function threadIdsAt(path: string): Promise<string[]> {
  const record = await new BrowserWorkspaceDocs().open(getBrowserWorkspaceId())
  const entry = record === null ? null : resolveWorkspaceDocument(record, path)
  if (record === null || entry === null) throw new Error(`no document at ${path}`)
  return readCommentThreads(documentContainers(record, entry.documentId)).map((t) => t.id)
}

it('copies beside the source, named after it, with its content and a last-edited time', async () => {
  const index = new BrowserDocumentIndex()
  await seedRoadmap(index)

  const copy = await duplicateBrowserDocument({
    index,
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
  const index = new BrowserDocumentIndex()
  await seedRoadmap(index)
  const duplicate = () =>
    duplicateBrowserDocument({
      index,
      clock: idbContentClock(),
      sourcePath: 'notes/roadmap',
    })

  const copies = await Promise.all([duplicate(), duplicate()])

  expect(copies.map((copy) => copy.path).sort()).toEqual([
    'notes/roadmap-copy',
    'notes/roadmap-copy-2',
  ])
})

it('copies without the comment threads when asked, and the source keeps them', async () => {
  const index = new BrowserDocumentIndex()
  await seedRoadmap(index)

  const copy = await duplicateBrowserDocument({
    index,
    clock: idbContentClock(),
    sourcePath: 'notes/roadmap',
    withoutAnnotations: true,
  })

  expect(copy).toMatchObject({ path: 'notes/roadmap-copy', name: 'Roadmap (copy)' })
  const content = await loadDocumentContent(copy.documentId)
  expect(content === null ? null : readMarkdownBody(content)).toBe('# Roadmap\n\nship it')
  await expect(threadIdsAt('notes/roadmap-copy')).resolves.toEqual([])
  await expect(threadIdsAt('notes/roadmap')).resolves.toEqual(['t1'])
})
