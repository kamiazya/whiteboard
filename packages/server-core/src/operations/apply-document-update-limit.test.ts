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
  moveWorkspaceDocument,
  moveWorkspaceNodeToPath,
  readMarkdownBody,
  readSpatialCanvas,
  readWorkspaceDocuments,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroText } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { DocumentEngineTrapError } from '../document-io.js'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { FakeVersionHistory } from '../test-utils/fake-version-history.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'
import {
  MarkdownBodyTooLargeError,
  NodeTextTooLargeError,
  OffGrammarPathError,
} from './apply-document-update-limit.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { promoteWorkspace } from './promote-workspace.js'

const WS = 'ws-1'
const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const PATH = 'notes'
const OTHER_ID = '01BRWAAAAAAAAAAAAAAAAAAAA6'

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

  it('joins pieces of characters outside the BMP into one run, counting them as the engine does', async () => {
    const store = new StoredDoc(workspaceSeed('short'))
    const client = store.get().fork()
    client.setRecordTimestamp(true)
    client.setChangeMergeInterval(0)
    const from = client.oplogVersion()
    const body = workspaceBody(client)
    // The engine's counters advance per scalar while a JS string holds two
    // units for each of these, so a run counted in units never joins up.
    const piece = '\u{1F600}'.repeat(MARKDOWN_MAX_CHARS / 4 + 1)
    body.insert(body.length, piece)
    client.commit({ timestamp: 1_000 })
    body.insert(body.length, piece)
    client.commit({ timestamp: 1_000_000 })
    const update = client.export({ mode: 'update', from })

    const refusal = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update,
    }).catch((err: unknown) => err)

    expect(refusal).toMatchObject({ shape: 'run', chars: 2 * piece.length })
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

/**
 * The same four edits `browser-backend.body-limit.test.ts` pushes to the
 * browser keeper, with the same verdicts: both keepers judge a write by what
 * it does to the text, so a write one keeper takes the other takes.
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
])('$edit, sent to the daemon', ({ before, change, after }) => {
  it(`as a workspace-record update ${after === null ? 'is refused' : 'is applied'}`, async () => {
    const store = new StoredDoc(workspaceSeed('y'.repeat(before)))
    const update = updateFrom(store.get(), (doc) => change(workspaceBody(doc)))

    const applied = applyWorkspaceDocumentUpdate(workspaceDeps(store), { workspaceId: WS, update })

    if (after === null) await expect(applied).rejects.toBeInstanceOf(MarkdownBodyTooLargeError)
    else await expect(applied).resolves.toBe('applied')
    expect(storedWorkspaceBody(store)).toHaveLength(after ?? before)
  })

  it(`as a per-document update ${after === null ? 'is refused' : 'is applied'}`, async () => {
    const store = new StoredDoc(liveSeed('y'.repeat(before)))
    const update = updateFrom(store.get(), (doc) => change(doc.getText('body')))

    const applied = applyDocumentUpdate(liveDeps(store), { workspaceId: WS, path: PATH, update })

    if (after === null) await expect(applied).rejects.toBeInstanceOf(MarkdownBodyTooLargeError)
    else await expect(applied).resolves.toBeDefined()
    expect(readMarkdownBody(store.get())).toHaveLength(after ?? before)
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

const storedPathsOf = (store: StoredDoc) =>
  readWorkspaceDocuments(store.get()).map((entry) => entry.path)

describe('a workspace-document sync update that moves a path', () => {
  it('onto a path outside the document-path grammar is refused and nothing is imported', async () => {
    const store = new StoredDoc(workspaceSeed('body'))
    const update = updateFrom(store.get(), (doc) => {
      expect(moveWorkspaceNodeToPath(doc, PATH, 'Meeting notes')).toBe(true)
    })

    const refusal = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update,
    }).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(OffGrammarPathError)
    expect(refusal).toMatchObject({ paths: ['Meeting notes'] })
    expect(store.saves).toBe(0)
    expect(storedPathsOf(store)).toEqual([PATH])
  })

  it('creating a document outside the grammar is refused', async () => {
    const store = new StoredDoc(workspaceSeed('body'))
    const update = updateFrom(store.get(), (doc) =>
      createWorkspaceDocumentAtPath(doc, {
        path: 'notes/Ä',
        documentId: '01BRWAAAAAAAAAAAAAAAAAAAA5',
        kind: 'markdown',
      }),
    )

    await expect(
      applyWorkspaceDocumentUpdate(workspaceDeps(store), { workspaceId: WS, update }),
    ).rejects.toMatchObject({ paths: ['notes/Ä'] })
    expect(storedPathsOf(store)).toEqual([PATH])
  })

  it('off a path already outside the grammar onto one inside it is applied', async () => {
    const seed = workspaceSeed('body')
    moveWorkspaceNodeToPath(seed, PATH, 'Meeting notes')
    seed.commit()
    const store = new StoredDoc(seed)
    const update = updateFrom(store.get(), (doc) => {
      expect(moveWorkspaceNodeToPath(doc, 'Meeting notes', 'meeting-notes')).toBe(true)
    })

    await expect(
      applyWorkspaceDocumentUpdate(workspaceDeps(store), { workspaceId: WS, update }),
    ).resolves.toBe('applied')
    expect(storedPathsOf(store)).toEqual(['meeting-notes'])
  })

  it('that leaves an already off-grammar path where it was is applied', async () => {
    const seed = workspaceSeed('body')
    moveWorkspaceNodeToPath(seed, PATH, 'Meeting notes')
    seed.commit()
    const store = new StoredDoc(seed)
    const update = updateFrom(store.get(), (doc) => workspaceBody(doc).insert(0, 'more '))

    await expect(
      applyWorkspaceDocumentUpdate(workspaceDeps(store), { workspaceId: WS, update }),
    ).resolves.toBe('applied')
    expect(storedWorkspaceBody(store)).toBe('more body')
  })

  it('that nests a document under one already off the grammar is refused, naming only the new path', async () => {
    const seed = workspaceSeed('body')
    moveWorkspaceNodeToPath(seed, PATH, 'Meeting notes')
    createWorkspaceDocumentAtPath(seed, { path: 'other', documentId: OTHER_ID, kind: 'markdown' })
    seed.commit()
    const store = new StoredDoc(seed)
    // A tree move alone, with no segment written: the parent changes the path.
    const update = updateFrom(store.get(), (doc) =>
      moveWorkspaceDocument(doc, { documentId: OTHER_ID, parentId: DOC_ID }),
    )

    await expect(
      applyWorkspaceDocumentUpdate(workspaceDeps(store), { workspaceId: WS, update }),
    ).rejects.toMatchObject({ paths: ['Meeting notes/other'] })
    expect(storedPathsOf(store)).toEqual(['Meeting notes', 'other'])
  })
})

/** Makes the `nth` attach on `doc` abort the way the WASM engine does. */
function trapOnAttach(doc: LoroDoc, nth: number): void {
  const attach = doc.attach.bind(doc)
  let calls = 0
  doc.attach = () => {
    calls += 1
    if (calls === nth) throw Object.assign(new Error('unreachable'), { name: 'RuntimeError' })
    attach()
  }
}

describe('an engine trap while a sync update is brought into the state', () => {
  it('drops the cached record and answers DocumentEngineTrapError', async () => {
    const store = new StoredDoc(workspaceSeed('body'))
    const update = updateFrom(store.get(), (doc) => workspaceBody(doc).insert(0, 'more '))
    trapOnAttach(store.get(), 1)

    const refusal = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update,
    }).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(DocumentEngineTrapError)
    expect(store.evictions).toBe(1)
    expect(store.saves).toBe(0)
    expect(storedWorkspaceBody(store)).toBe('body')
  })

  it('drops the cached record when the trap comes after taking the state back for the path check', async () => {
    const seed = workspaceSeed('body')
    moveWorkspaceNodeToPath(seed, PATH, 'Meeting notes')
    createWorkspaceDocumentAtPath(seed, { path: 'other', documentId: OTHER_ID, kind: 'markdown' })
    seed.commit()
    const store = new StoredDoc(seed)
    const update = updateFrom(store.get(), (doc) =>
      moveWorkspaceDocument(doc, { documentId: OTHER_ID, parentId: DOC_ID }),
    )
    // The first attach brings the update in; the second follows the checkout.
    trapOnAttach(store.get(), 2)

    const refusal = await applyWorkspaceDocumentUpdate(workspaceDeps(store), {
      workspaceId: WS,
      update,
    }).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(DocumentEngineTrapError)
    expect(store.evictions).toBe(1)
    expect(storedPathsOf(store)).toEqual(['Meeting notes', 'other'])
  })

  it('rethrows an attach failure that is not a trap untouched, without dropping the cached doc', async () => {
    const store = new StoredDoc(liveSeed('short'))
    const update = updateFrom(store.get(), (doc) => doc.getText('body').insert(5, ' note'))
    const cached = store.get()
    cached.attach = () => {
      throw new Error('refused')
    }

    await expect(
      applyDocumentUpdate(liveDeps(store), { workspaceId: WS, path: PATH, update }),
    ).rejects.toThrow('refused')
    expect(store.evictions).toBe(0)
  })

  it('drops a per-document cached doc too', async () => {
    const store = new StoredDoc(liveSeed('short'))
    const update = updateFrom(store.get(), (doc) => doc.getText('body').insert(5, ' note'))
    trapOnAttach(store.get(), 1)

    await expect(
      applyDocumentUpdate(liveDeps(store), { workspaceId: WS, path: PATH, update }),
    ).rejects.toBeInstanceOf(DocumentEngineTrapError)
    expect(store.evictions).toBe(1)
    expect(readMarkdownBody(store.get())).toBe('short')
  })
})

describe('MarkdownBodyTooLargeError', () => {
  it('says which limit a run broke and which a body broke', () => {
    expect(new MarkdownBodyTooLargeError('run', 300_000).message).toMatch(
      /^This update inserts 300000 characters in one piece, past the 262144-character limit for one write/,
    )
    expect(new MarkdownBodyTooLargeError('body', 300_000).message).toMatch(
      /^This update would make a document body 300000 characters long, past the 262144-character limit for one document/,
    )
  })
})

describe('a sync update that writes a node', () => {
  const textNode = (text: string, x = 0): SpatialNode => ({
    id: 'n1',
    resource: { mimeType: 'text/markdown', content: text },
    x,
    y: 0,
    width: 200,
    height: 100,
  })
  const spatialSeed = (text?: string) => {
    const doc = new LoroDoc()
    if (text !== undefined) writeSpatialNode(doc, textNode(text))
    return doc
  }
  const storedText = (store: StoredDoc) => {
    const node = readSpatialCanvas(store.get()).nodes[0]
    return node?.resource?.content
  }
  const send = (store: StoredDoc, edit: (doc: LoroDoc) => void) =>
    applyDocumentUpdate(liveDeps(store), {
      workspaceId: WS,
      path: PATH,
      update: updateFrom(store.get(), edit),
    })

  it('adding text past the node limit is refused and nothing is kept', async () => {
    const store = new StoredDoc(spatialSeed())

    const refusal = await send(store, (doc) =>
      writeSpatialNode(doc, textNode('x'.repeat(NODE_TEXT_MAX_CHARS + 1))),
    ).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(NodeTextTooLargeError)
    expect(refusal).toMatchObject({ nodeId: 'n1', chars: NODE_TEXT_MAX_CHARS + 1 })
    expect(store.saves).toBe(0)
    expect(readSpatialCanvas(store.get()).nodes).toEqual([])
  })

  it('growing a node already past the limit is refused', async () => {
    const stored = 'y'.repeat(NODE_TEXT_MAX_CHARS + 10)
    const store = new StoredDoc(spatialSeed(stored))

    await expect(
      send(store, (doc) => writeSpatialNode(doc, textNode(`${stored}!`))),
    ).rejects.toBeInstanceOf(NodeTextTooLargeError)
    expect(storedText(store)).toBe(stored)
  })

  it('moving or shrinking a node stored past the limit is applied', async () => {
    const stored = 'y'.repeat(NODE_TEXT_MAX_CHARS + 10)
    const store = new StoredDoc(spatialSeed(stored))

    await send(store, (doc) => writeSpatialNode(doc, textNode(stored, 40)))
    await send(store, (doc) => writeSpatialNode(doc, textNode(stored.slice(5), 40)))

    expect(storedText(store)).toHaveLength(NODE_TEXT_MAX_CHARS + 5)
  })

  it('in the legacy shape, carrying its text in its own field, is judged the same', async () => {
    const store = new StoredDoc(spatialSeed())

    await expect(
      send(store, (doc) =>
        doc.getMap('nodes').set('n1', {
          id: 'n1',
          type: 'text',
          text: 'x'.repeat(NODE_TEXT_MAX_CHARS + 1),
          x: 0,
          y: 0,
          width: 200,
          height: 100,
        }),
      ),
    ).rejects.toBeInstanceOf(NodeTextTooLargeError)
  })

  it('under a workspace-tree node is refused through the workspace record', async () => {
    const seed = new LoroDoc()
    createWorkspaceDocumentAtPath(seed, { path: 'board', documentId: OTHER_ID, kind: 'spatial' })
    seed.commit()
    const store = new StoredDoc(seed)
    const update = updateFrom(store.get(), (doc) =>
      writeSpatialNode(documentContainers(doc, OTHER_ID), textNode('x'.repeat(1_000_000))),
    )

    await expect(
      applyWorkspaceDocumentUpdate(workspaceDeps(store), { workspaceId: WS, update }),
    ).rejects.toMatchObject({ nodeId: 'n1', chars: 1_000_000 })
    expect(store.saves).toBe(0)
  })

  it('a map value elsewhere, past the node limit, is not node text', async () => {
    const store = new StoredDoc(spatialSeed())

    await send(store, (doc) =>
      doc
        .getMap('canvas')
        .set('note', { resource: { content: 'x'.repeat(NODE_TEXT_MAX_CHARS + 1) } }),
    )

    expect(store.saves).toBe(1)
  })
})
