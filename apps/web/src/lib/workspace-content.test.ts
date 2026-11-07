/**
 * A document's content is the workspace tree's node and nothing else: there is
 * no per-document record to fall back on, so an id the tree does not hold is
 * `null` and a tree that cannot be read is an unreadable answer, never `null`.
 */
import 'fake-indexeddb/auto'
import { writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedPreTreeContentRow } from '../test-utils/seed-retired-sync-row.js'
import { seedTreeDocument } from '../test-utils/seed-workspace-content.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { loadDocumentContent } from './workspace-content.js'

claimIsolatedWhiteboardDb('workspace-content')

describe('loadDocumentContent', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(() => vi.restoreAllMocks())

  it('projects a document the tree holds', async () => {
    const source = new Loro()
    writeMarkdownBody(source, 'held by the tree')
    const entry = await seedTreeDocument({
      path: 'notes/held',
      kind: 'markdown',
      content: source.export({ mode: 'snapshot' }),
    })

    expect(await loadDocumentContent(entry.documentId)).not.toBeNull()
  })

  it('answers null for an id the tree does not hold, even beside a per-document record', async () => {
    await seedTreeDocument({ path: 'notes/other', kind: 'markdown' })
    const stray = generateDocumentId()
    await seedPreTreeContentRow(stray)

    expect(await loadDocumentContent(stray)).toBeNull()
  })

  it('throws, rather than answering null, when the tree could not be read', async () => {
    const entry = await seedTreeDocument({ path: 'notes/held', kind: 'markdown' })
    vi.spyOn(BrowserWorkspaceDocs.prototype, 'open').mockRejectedValue(new Error('closed'))

    await expect(loadDocumentContent(entry.documentId)).rejects.toThrow(/could not be read/)
  })
})
