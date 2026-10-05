/**
 * The browser keeper refuses to persist a markdown body past
 * `MARKDOWN_MAX_CHARS`, as the daemon refuses to store one: a document cannot
 * hold a body one keeper accepts and the other refuses, which is what a later
 * promotion would otherwise trip over.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { BrowserBackend } from './browser-backend.js'
import type { LoroStore } from './loro-store.js'

// jsdom has no IndexedDB, so the startup fold and the timestamp touch are
// replaced by their outcome; see browser-backend.read-failure.test.ts.
vi.mock('./fold-workspace.js', () => ({
  foldWorkspaceDocuments: async () => ({ folded: 0, skipped: 0 }),
}))
vi.mock('./loro-store.js', () => ({ LoroStore: class {}, touchContentTimestamp: async () => {} }))

const TARGET = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  path: 'notes',
  kind: 'markdown' as const,
}

async function connected(body: string) {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: TARGET.path,
    documentId: TARGET.documentId,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(record, TARGET.documentId), body)
  const saved: string[] = []
  const docs = {
    create: async () => record,
    save: async (_workspaceId: string, doc: LoroDoc) => {
      saved.push(readMarkdownBody(documentContainers(doc, TARGET.documentId)))
      return null
    },
  } as unknown as WorkspaceDocs
  const backend = new BrowserBackend(TARGET, docs, {} as LoroStore)
  const reasons: string[] = []
  let snapshot: Uint8Array | null = null
  backend.connect({
    onConnected: () => {},
    onSnapshot: (bytes: Uint8Array) => {
      snapshot = bytes
    },
    onRemoteUpdate: () => {},
    onError: (reason: string) => reasons.push(reason),
  } as never)
  await vi.waitFor(() => expect(snapshot).not.toBeNull())
  const session = LoroDoc.fromSnapshot(snapshot as unknown as Uint8Array)
  const push = (text: string) => {
    const from = session.oplogVersion()
    documentContainers(session, TARGET.documentId).getText('body').insert(0, text)
    session.commit()
    return backend.pushLocalUpdate(session.export({ mode: 'update', from }))
  }
  return { saved, reasons, push, record }
}

describe('a browser-kept markdown body pushed past the limit', () => {
  it('is not persisted, and the session is told the write failed', async () => {
    const { saved, reasons, push, record } = await connected('y'.repeat(MARKDOWN_MAX_CHARS - 1))

    await push('ab')

    await expectLoggedFailure('refused a body past the markdown size limit')
    expect(saved).toEqual([])
    expect(reasons).toEqual(['storage-failure'])
    expect(readMarkdownBody(documentContainers(record, TARGET.documentId))).toHaveLength(
      MARKDOWN_MAX_CHARS - 1,
    )
  })

  it('within the limit is persisted', async () => {
    const { saved, reasons, push } = await connected('short')

    await push('a ')

    expect(saved).toEqual(['a short'])
    expect(reasons).toEqual([])
  })
})
