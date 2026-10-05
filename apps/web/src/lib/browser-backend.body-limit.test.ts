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
import { LoroDoc, type LoroText } from 'loro-crdt'
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
  const pushEdit = (edit: (body: LoroText) => void) => {
    const from = session.oplogVersion()
    edit(documentContainers(session, TARGET.documentId).getText('body'))
    session.commit()
    return backend.pushLocalUpdate(session.export({ mode: 'update', from }))
  }
  const push = (text: string) => pushEdit((body) => body.insert(0, text))
  return { saved, reasons, push, pushEdit, record }
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

/**
 * The same four edits `apply-document-update-limit.test.ts` sends through the
 * daemon's sync operation, with the same verdicts: both keepers judge a write
 * by what it does to the text, so a write one keeper takes the other takes.
 */
describe.each([
  {
    edit: 'a select-all replace that shrinks the body',
    before: 200_000,
    change: (body: LoroText) => {
      body.delete(0, body.length)
      body.insert(0, 'z'.repeat(100_000))
    },
    after: 100_000,
  },
  {
    edit: 'a delete from a body already past the limit',
    before: MARKDOWN_MAX_CHARS + 10,
    change: (body: LoroText) => body.delete(0, 5),
    after: MARKDOWN_MAX_CHARS + 5,
  },
  {
    edit: 'a small insert growing the body past the limit',
    before: MARKDOWN_MAX_CHARS - 3,
    change: (body: LoroText) => body.insert(0, 'four'),
    after: null,
  },
  {
    edit: 'one run past the limit',
    before: 5,
    change: (body: LoroText) => body.insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1)),
    after: null,
  },
])('$edit, pushed to the browser keeper', ({ before, change, after }) => {
  it(after === null ? 'is refused' : 'is persisted', async () => {
    const { saved, reasons, pushEdit } = await connected('y'.repeat(before))

    await pushEdit(change)

    if (after === null) {
      await expectLoggedFailure('refused a body past the markdown size limit')
      expect(saved).toEqual([])
      expect(reasons).toEqual(['storage-failure'])
    } else {
      expect(saved.map((body) => body.length)).toEqual([after])
      expect(reasons).toEqual([])
    }
  })
})
