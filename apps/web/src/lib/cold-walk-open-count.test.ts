/**
 * A cold walk over a browser workspace opens the workspace record once, not
 * once per document: the record holds every document, so a per-document open
 * is quadratic in the workspace on the first list, search and backlink ask.
 */
import 'fake-indexeddb/auto'
import {
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { browserBacklinksReader } from './browser-backlinks.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { ensureLocalWorkspace } from './local-document-summary.js'
import { createLocalFilesSource } from './local-files-source.js'
import { LoroStore } from './loro-store.js'
import { seedWorkspaceDocumentContent } from './workspace-content.js'

claimIsolatedWhiteboardDb('cold-walk-open-count')

const DOCUMENTS = 20
// Seeding twenty documents through fake IndexedDB outlasts the default under a loaded parallel run.
const SEEDED_WALK_TIMEOUT_MS = 30_000

async function seedWorkspace(): Promise<{ index: FoldingBrowserIndex; documentIds: string[] }> {
  const index = new FoldingBrowserIndex()
  await ensureLocalWorkspace(index)
  const documentIds: string[] = []
  for (let n = 0; n < DOCUMENTS; n++) {
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: `docs/d${n}`,
      kind: 'markdown',
    })
    const doc = new Loro()
    writeDocumentKind(doc, 'markdown')
    writeCoreFacets(doc, { type: 'note', tags: [`t${n % 7}`] })
    writeMarkdownBody(doc, `Body ${n} links [[docs/d0]].`)
    expect(
      await seedWorkspaceDocumentContent(entry.documentId, doc.export({ mode: 'snapshot' })),
    ).toBe(true)
    documentIds.push(entry.documentId)
  }
  return { index, documentIds }
}

/**
 * Opens a walk costs beyond what the SAME ask costs once every document is
 * answered from a cache. The index listing and the pin order open the record
 * themselves, so the absolute count is not the walk's; the difference is, and
 * it is independent of how many documents the workspace holds.
 */
async function opensForTheColdWalk(ask: () => Promise<unknown>): Promise<number> {
  const opens = vi.spyOn(DocumentStoreWorkspaceDocs.prototype, 'open')
  await ask()
  const cold = opens.mock.calls.length
  opens.mockClear()
  await ask()
  return cold - opens.mock.calls.length
}

describe('a cold walk over a browser workspace', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(() => vi.restoreAllMocks())

  it('opens the workspace record once to read every document for the listing', {
    timeout: SEEDED_WALK_TIMEOUT_MS,
  }, async () => {
    const { index } = await seedWorkspace()
    const source = createLocalFilesSource({ index })
    let listed: Awaited<ReturnType<typeof source.listDocuments>> = []

    const walkOpens = await opensForTheColdWalk(async () => {
      listed = await source.listDocuments()
    })

    // The subject must be present: a tag only appears once its body was read.
    expect(listed.filter((entry) => (entry.tags ?? []).length > 0)).toHaveLength(DOCUMENTS)
    expect(walkOpens).toBe(1)
  })

  it('opens the workspace record once to build the search corpus', {
    timeout: SEEDED_WALK_TIMEOUT_MS,
  }, async () => {
    const { index } = await seedWorkspace()
    const source = createLocalFilesSource({ index })
    await source.listDocuments()
    let hits: Awaited<ReturnType<typeof source.searchDocuments>> = []

    const walkOpens = await opensForTheColdWalk(async () => {
      hits = await source.searchDocuments('Body')
    })

    expect(hits).toHaveLength(DOCUMENTS)
    expect(walkOpens).toBe(1)
  })

  it('opens the workspace record once to build backlinks over every document', {
    timeout: SEEDED_WALK_TIMEOUT_MS,
  }, async () => {
    const { index, documentIds } = await seedWorkspace()
    const read = browserBacklinksReader(index, new LoroStore())
    let backlinks = 0

    const walkOpens = await opensForTheColdWalk(async () => {
      backlinks = (await read(documentIds[0] as string)).backlinks.length
    })

    expect(backlinks).toBe(DOCUMENTS - 1)
    expect(walkOpens).toBe(1)
  })

  // The record is opened per ask, never kept between them: a kept one would
  // answer the next ask from the content as it stood at the first.
  it('reads an edit made between two backlink asks', {
    timeout: SEEDED_WALK_TIMEOUT_MS,
  }, async () => {
    const { index, documentIds } = await seedWorkspace()
    const read = browserBacklinksReader(index, new LoroStore())
    expect((await read(documentIds[0] as string)).backlinks).toHaveLength(DOCUMENTS - 1)
    const unlinked = new Loro()
    writeDocumentKind(unlinked, 'markdown')
    writeMarkdownBody(unlinked, 'No link any more.')

    await seedWorkspaceDocumentContent(
      documentIds[1] as string,
      unlinked.export({ mode: 'snapshot' }),
    )

    expect((await read(documentIds[0] as string)).backlinks).toHaveLength(DOCUMENTS - 2)
  })
})
