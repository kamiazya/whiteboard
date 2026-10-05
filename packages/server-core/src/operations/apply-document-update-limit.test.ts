/**
 * The markdown size limit on the editor's sync writes.
 *
 * The JSON writers refuse a body past `MARKDOWN_MAX_CHARS` through
 * `markdownInputSchema`; the sync writes carry Loro bytes no schema can read,
 * so the limit is checked against what the bytes would DO. Each double keeps a
 * stored snapshot beside its cached instance, so "nothing was imported" is
 * observable as what the next read finds, not only as a save that did not run.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroText } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { FakeVersionHistory } from '../test-utils/fake-version-history.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'
import { MarkdownBodyTooLargeError } from './apply-document-update-limit.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { promoteWorkspace } from './promote-workspace.js'

const WS = 'ws-1'
const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const PATH = 'notes'

/** A cache over a stored snapshot: `evict` drops the instance, `get` rebuilds from what was saved. */
class StoredDoc {
  private stored: Uint8Array
  private cached: LoroDoc | null = null
  saves = 0
  evictions = 0

  constructor(seed: LoroDoc) {
    this.stored = seed.export({ mode: 'snapshot' })
  }

  get(): LoroDoc {
    if (this.cached === null) this.cached = LoroDoc.fromSnapshot(this.stored)
    return this.cached
  }

  save(doc: LoroDoc): void {
    this.saves += 1
    this.stored = doc.export({ mode: 'snapshot' })
  }

  evict(): void {
    this.evictions += 1
    this.cached = null
  }
}

function workspaceSeed(body: string): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: PATH, documentId: DOC_ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, DOC_ID), body)
  doc.commit()
  return doc
}

function liveSeed(body: string): LoroDoc {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, body)
  return doc
}

const lock: Pick<LiveDocuments, 'withWriteLock'> = {
  withWriteLock: (_workspaceId, fn) => fn(),
}

function workspaceDeps(store: StoredDoc) {
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    exists: async () => true,
    get: async () => store.get(),
    save: async (_workspaceId, doc) => store.save(doc),
    evict: () => store.evict(),
    evictProjections: () => {},
  }
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    ...lock,
    get: async () => {
      throw new Error('a refused promote reached the per-document checkpoint pass')
    },
  }
  return { liveDocuments, workspaceDocuments, versions: new FakeVersionHistory() }
}

function liveDeps(store: StoredDoc) {
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    ...lock,
    get: async () => store.get(),
    save: async (_workspaceId, _path, doc) => store.save(doc),
    evict: () => store.evict(),
  }
  return { liveDocuments }
}

/** What a client holding `base` would send after `edit`. */
function updateFrom(base: LoroDoc, edit: (doc: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

const workspaceBody = (doc: LoroDoc): LoroText => documentContainers(doc, DOC_ID).getText('body')
const storedWorkspaceBody = (store: StoredDoc) =>
  readMarkdownBody(documentContainers(store.get(), DOC_ID))

describe('a workspace-document sync update', () => {
  it('that inserts one run past the limit is refused and nothing is imported', async () => {
    const store = new StoredDoc(workspaceSeed('short'))
    const update = updateFrom(store.get(), (doc) =>
      workspaceBody(doc).insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1)),
    )

    const refusal = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update,
    }).catch((err: unknown) => err)

    // Refused as a RUN: measured before the state is brought up, which is the
    // half of the import whose cost is quadratic in that run.
    expect(refusal).toBeInstanceOf(MarkdownBodyTooLargeError)
    expect(refusal).toMatchObject({ shape: 'run', chars: MARKDOWN_MAX_CHARS + 1 })
    expect(store.saves).toBe(0)
    expect(storedWorkspaceBody(store)).toBe('short')
  })

  it('that inserts one run past the limit across several changes is refused as one run', async () => {
    const store = new StoredDoc(workspaceSeed('short'))
    const client = store.get().fork()
    // Separate changes, as a client committing a paste piece by piece leaves
    // them; the engine still joins adjacent pieces into one run.
    client.setRecordTimestamp(true)
    client.setChangeMergeInterval(0)
    const from = client.oplogVersion()
    const body = workspaceBody(client)
    const half = MARKDOWN_MAX_CHARS / 2 + 1
    body.insert(body.length, 'x'.repeat(half))
    client.commit({ timestamp: 1_000 })
    body.insert(body.length, 'x'.repeat(half))
    client.commit({ timestamp: 1_000_000 })
    const update = client.export({ mode: 'update', from })

    const refusal = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update,
    }).catch((err: unknown) => err)

    expect(refusal).toMatchObject({ shape: 'run', chars: 2 * half })
    expect(storedWorkspaceBody(store)).toBe('short')
  })

  it('that grows a body past the limit with a small insert is refused and nothing is imported', async () => {
    const body = 'y'.repeat(MARKDOWN_MAX_CHARS - 3)
    const store = new StoredDoc(workspaceSeed(body))
    const update = updateFrom(store.get(), (doc) => workspaceBody(doc).insert(0, 'four'))

    await expect(
      applyWorkspaceDocumentUpdate(workspaceDeps(store), { workspaceId: WS, update }),
    ).rejects.toThrow(/262144-character limit/)

    expect(store.saves).toBe(0)
    expect(storedWorkspaceBody(store)).toBe(body)
  })

  it('that brings a body exactly to the limit is applied', async () => {
    const store = new StoredDoc(workspaceSeed('y'.repeat(MARKDOWN_MAX_CHARS - 3)))
    const update = updateFrom(store.get(), (doc) => workspaceBody(doc).insert(0, 'abc'))

    await expect(
      applyWorkspaceDocumentUpdate(workspaceDeps(store), { workspaceId: WS, update }),
    ).resolves.toBe('applied')

    expect(storedWorkspaceBody(store)).toHaveLength(MARKDOWN_MAX_CHARS)
  })

  it('that shrinks a body already past the limit is applied', async () => {
    const store = new StoredDoc(workspaceSeed('z'.repeat(MARKDOWN_MAX_CHARS + 10)))
    const update = updateFrom(store.get(), (doc) => workspaceBody(doc).delete(0, 5))

    await expect(
      applyWorkspaceDocumentUpdate(workspaceDeps(store), { workspaceId: WS, update }),
    ).resolves.toBe('applied')

    expect(storedWorkspaceBody(store)).toHaveLength(MARKDOWN_MAX_CHARS + 5)
  })
})

describe('a per-document sync update', () => {
  it('that grows the body past the limit is refused and nothing is imported', async () => {
    const body = 'y'.repeat(MARKDOWN_MAX_CHARS)
    const store = new StoredDoc(liveSeed(body))
    const update = updateFrom(store.get(), (doc) => doc.getText('body').insert(0, '!'))

    await expect(
      applyDocumentUpdate(liveDeps(store), { workspaceId: WS, path: PATH, update }),
    ).rejects.toBeInstanceOf(MarkdownBodyTooLargeError)

    expect(store.saves).toBe(0)
    expect(readMarkdownBody(store.get())).toBe(body)
  })

  it('that inserts one run past the limit is refused before the import is applied', async () => {
    const store = new StoredDoc(liveSeed('short'))
    const update = updateFrom(store.get(), (doc) =>
      doc.getText('body').insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1)),
    )

    await expect(
      applyDocumentUpdate(liveDeps(store), { workspaceId: WS, path: PATH, update }),
    ).rejects.toMatchObject({ shape: 'run' })

    expect(store.evictions).toBe(1)
    expect(readMarkdownBody(store.get())).toBe('short')
  })

  it('within the limit is applied', async () => {
    const store = new StoredDoc(liveSeed('short'))
    const update = updateFrom(store.get(), (doc) => doc.getText('body').insert(5, ' note'))

    await applyDocumentUpdate(liveDeps(store), { workspaceId: WS, path: PATH, update })

    expect(readMarkdownBody(store.get())).toBe('short note')
  })
})

describe('a promoted record', () => {
  it('holding a body past the limit is refused and nothing is merged', async () => {
    const target = new StoredDoc(workspaceSeed('the daemon copy'))
    const record = new LoroDoc()
    createWorkspaceDocumentAtPath(record, {
      path: 'big',
      documentId: '01BRWAAAAAAAAAAAAAAAAAAAA9',
      kind: 'markdown',
    })
    writeMarkdownBody(
      documentContainers(record, '01BRWAAAAAAAAAAAAAAAAAAAA9'),
      'p'.repeat(MARKDOWN_MAX_CHARS + 1),
    )

    await expect(
      promoteWorkspace(workspaceDeps(target), {
        workspaceId: WS,
        snapshot: record.export({ mode: 'snapshot' }),
        operator: { kind: 'human', displayName: 'Yuki' },
      }),
    ).rejects.toBeInstanceOf(MarkdownBodyTooLargeError)

    expect(target.saves).toBe(0)
    expect(storedWorkspaceBody(target)).toBe('the daemon copy')
  })
})
