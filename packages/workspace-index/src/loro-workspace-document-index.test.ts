/**
 * The tree-backed index, held to the port's own conformance suite — the same
 * one the in-memory, libSQL and IndexedDB indexes pass.
 *
 * That is the whole point of running it here: a workspace tree is a different
 * shape of storage from a table of rows, and the question worth answering is
 * whether it can still promise what the port promises. Where it cannot, the
 * suite says so rather than a comment claiming it does.
 */

import type { BlobStore, RenameWorkspaceInput, WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import {
  blobRefKey,
  DocumentPathTakenError,
  WorkspaceNotFoundError,
  WorkspaceSegmentTakenError,
} from '@kamiazya/whiteboard-ports'
import {
  describeDocumentIndexConformance,
  describeDocumentPinsConformance,
  describeDocumentTrashConformance,
} from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import type { WorkspaceDocs } from './workspace-docs.js'

/** The registry half of a rename: segment uniqueness across `workspaceIds`, then the new identity. */
function renameIdentity(
  identities: Map<string, WorkspaceEntry>,
  workspaceIds: readonly string[],
  { workspaceId, segment, displayName }: RenameWorkspaceInput,
): WorkspaceEntry {
  const rows = workspaceIds.map(
    (id) => identities.get(id) ?? ({ workspaceId: id } satisfies WorkspaceEntry),
  )
  if (
    segment !== undefined &&
    rows.some((row) => row.segment === segment && row.workspaceId !== workspaceId)
  ) {
    throw new WorkspaceSegmentTakenError(segment)
  }
  const renamed: WorkspaceEntry = {
    ...(identities.get(workspaceId) ?? { workspaceId }),
    ...(segment === undefined ? {} : { segment }),
    ...(displayName === undefined ? {} : { displayName }),
  }
  identities.set(workspaceId, renamed)
  return renamed
}

/**
 * Workspace documents in memory, kept the way a real store keeps them: only
 * what `save` exported survives, and every `open` is a restart that imports it
 * into a document nobody else holds.
 *
 * A double whose `save` is a no-op over live documents passes an index that
 * never calls `save` at all, because the mutation is already in the very
 * object the next read returns. A real backing store would have lost it, so the
 * conformance suites run here must not be able to pass on that.
 *
 * Doubles as this index's `WorkspaceRegistry`, which is why it holds identity
 * separately from the documents: the tree index never writes a registry row —
 * `createWorkspace` only creates the tree doc — so `segment`/`displayName`
 * reach the registry through whoever owns it, which in the daemon is
 * `CacheCoherentDocumentIndex`'s override and here is `seedWorkspace`.
 */
function inMemoryWorkspaceDocs(): WorkspaceDocs & {
  listWorkspaces(): Promise<WorkspaceEntry[]>
  seedWorkspace(entry: WorkspaceEntry): Promise<void>
  renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceEntry>
} {
  const identities = new Map<string, WorkspaceEntry>()
  const stored = new Map<string, Uint8Array>()
  let nextPeer = 1n
  const fresh = (): LoroDoc => {
    const doc = new LoroDoc()
    doc.setPeerId(nextPeer)
    nextPeer += 1n
    return doc
  }
  const docs: ReturnType<typeof inMemoryWorkspaceDocs> = {
    async open(workspaceId) {
      const bytes = stored.get(workspaceId)
      if (bytes === undefined) return null
      const doc = fresh()
      doc.import(bytes)
      return doc
    },
    async create(workspaceId) {
      return (await docs.open(workspaceId)) ?? fresh()
    },
    async save(workspaceId, doc) {
      stored.set(workspaceId, doc.export({ mode: 'snapshot' }))
      return null
    },
    // These doubles serve INDEX tests, which never tail. Rejecting rather than
    // answering an empty cursor: a silent no-op would let a tailing test pass
    // against a double that cannot tail.
    readCursor: () => Promise.reject(new Error('not implemented')),
    catchUp: () => Promise.reject(new Error('not implemented')),
    async listWorkspaces() {
      return [...stored.keys()].map((workspaceId) => identities.get(workspaceId) ?? { workspaceId })
    },
    async seedWorkspace(entry) {
      identities.set(entry.workspaceId, entry)
      await docs.save(entry.workspaceId, await docs.create(entry.workspaceId))
    },
    async renameWorkspace(input) {
      if (!stored.has(input.workspaceId)) throw new WorkspaceNotFoundError(input.workspaceId)
      return renameIdentity(identities, [...stored.keys()], input)
    },
  }
  return docs
}

/** Enough of a `BlobStore` for the evacuation a delete performs. */
function inMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>()
  const key = blobRefKey
  let next = 0
  return {
    async put({ bytes }) {
      // A counter, not a real digest: nothing here reads the ref back for its
      // content-addressing, and a fake keeps this double synchronous in spirit.
      next += 1
      const ref = { algorithm: 'sha-256', digestHex: String(next).padStart(64, '0') } as const
      blobs.set(key(ref), new Uint8Array(bytes))
      return { ref }
    },
    async get({ ref }) {
      const bytes = blobs.get(key(ref))
      return bytes === undefined ? null : { bytes: new Uint8Array(bytes) }
    },
    async has({ ref }) {
      return { exists: blobs.has(key(ref)) }
    },
    async delete({ ref }) {
      blobs.delete(key(ref))
    },
  }
}

describe('LoroWorkspaceDocumentIndex', () => {
  describeDocumentIndexConformance(async () => {
    const docs = inMemoryWorkspaceDocs()
    return {
      index: new LoroWorkspaceDocumentIndex(docs, inMemoryBlobStore(), docs),
      dispose: async () => {},
      seedWorkspace: (entry) => docs.seedWorkspace(entry),
    }
  })
})

describe('LoroWorkspaceDocumentIndex pins', () => {
  describeDocumentPinsConformance(async () => {
    const docs = inMemoryWorkspaceDocs()
    return {
      index: new LoroWorkspaceDocumentIndex(docs, inMemoryBlobStore(), docs),
      dispose: async () => {},
    }
  })
})

describe('LoroWorkspaceDocumentIndex trash', () => {
  describeDocumentTrashConformance(async () => {
    const docs = inMemoryWorkspaceDocs()
    return {
      index: new LoroWorkspaceDocumentIndex(docs, inMemoryBlobStore(), docs),
      dispose: async () => {},
    }
  })
})

// Folders exist only in the tree, so these arrangements cannot be written
// against the port-wide suite: a row-backed index has no folder to empty or to
// collide with.
describe('LoroWorkspaceDocumentIndex folders', () => {
  const WS = 'ws-folders'

  async function makeIndex(): Promise<LoroWorkspaceDocumentIndex> {
    const docs = inMemoryWorkspaceDocs()
    const index = new LoroWorkspaceDocumentIndex(docs, inMemoryBlobStore(), docs)
    await index.createWorkspace({ workspaceId: WS })
    return index
  }

  it('frees the path of a folder a move emptied', async () => {
    const index = await makeIndex()
    await index.createDocument({ workspaceId: WS, path: 'a/b', kind: 'markdown' })
    await index.createDocument({ workspaceId: WS, path: 'x', kind: 'markdown' })
    await index.moveDocument({ workspaceId: WS, from: 'a/b', to: 'c' })

    // A folder left standing at `a` would occupy the path and refuse this.
    await index.moveDocument({ workspaceId: WS, from: 'x', to: 'a' })

    expect((await index.listDocuments({ workspaceId: WS })).map((e) => e.path)).toEqual(['a', 'c'])
  })

  it('refuses to move one of two siblings onto the folder they share, and changes nothing', async () => {
    const index = await makeIndex()
    await index.createDocument({ workspaceId: WS, path: 'a/x', kind: 'markdown' })
    await index.createDocument({ workspaceId: WS, path: 'a/y', kind: 'markdown' })

    // `a/y` stays below `a`, so the move does not vacate the folder.
    const rejection = await index
      .moveDocument({ workspaceId: WS, from: 'a/x', to: 'a' })
      .then(() => null)
      .catch((err: unknown) => err)

    expect(rejection).toBeInstanceOf(DocumentPathTakenError)
    expect((rejection as DocumentPathTakenError).path).toBe('a')
    expect((await index.listDocuments({ workspaceId: WS })).map((e) => e.path)).toEqual([
      'a/x',
      'a/y',
    ])
  })
})
