/**
 * What a promotion carries beside the record: the trash entries' evacuated
 * bytes and the saved versions, judged against the incoming record before
 * anything merges.
 */
import {
  contentDigestOfDocument,
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  documentContainers,
  exportWorkspaceSubtree,
  projectWorkspaceDocument,
  readMarkdownBody,
  readTrashEntries,
  recordTrashEntry,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { CANVAS_MAX_NODES, MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocuments } from '../server-deps.js'
import { FakeBlobStore } from '../test-utils/fake-blob-store.js'
import { FakeLiveDocuments } from '../test-utils/fake-live-documents.js'
import { FakeVersionHistory } from '../test-utils/fake-version-history.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { judgeCarried } from './promote-carried.js'
import { promoteWorkspace } from './promote-workspace.js'
import { TextBreachRefusalError } from './sync-write-refusals.js'

const WS = 'ws-1'
const ROADMAP_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const GONE_ID = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const DAEMON_OWN_ID = '01BRWAAAAAAAAAAAAAAAAAAAA3'
const EARLIER_TRASH_ID = '01BRWAAAAAAAAAAAAAAAAAAAA4'
const BOARD_ID = '01BRWAAAAAAAAAAAAAAAAAAAA5'
const operator = { kind: 'human' as const, displayName: 'Yuki' }

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A browser record (peer 2) with a version taken before the roadmap's last
 * edit, and one trashed note evacuated the way the browser keeper deletes.
 */
async function browserRecord() {
  const doc = new LoroDoc()
  doc.setPeerId(2n)
  createWorkspaceDocumentAtPath(doc, { path: 'roadmap', documentId: ROADMAP_ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, ROADMAP_ID), '# as drafted')
  doc.commit()
  const drafted = encodeFrontiers(doc.oplogFrontiers())
  writeMarkdownBody(documentContainers(doc, ROADMAP_ID), '# after the meeting')
  createWorkspaceDocumentAtPath(doc, { path: 'gone', documentId: GONE_ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, GONE_ID), '# trashed')
  doc.commit()
  const evacuated = exportWorkspaceSubtree(doc, 'gone')
  if (evacuated === null) throw new Error('no subtree to evacuate')
  deleteWorkspaceNodeAtPath(doc, 'gone')
  recordTrashEntry(doc, {
    documentId: GONE_ID,
    path: 'gone',
    deletedAt: 1,
    blob: { algorithm: 'sha-256', digestHex: await sha256Hex(evacuated) },
  })
  doc.commit()
  return {
    snapshot: doc.export({ mode: 'snapshot' }),
    trash: [{ documentId: GONE_ID, bytes: evacuated }],
    versions: [
      {
        id: 'browser-v1',
        documentId: ROADMAP_ID,
        createdAt: 1_000,
        auto: false,
        label: 'as drafted',
        frontiers: drafted,
      },
    ],
  }
}

/** A daemon workspace (peer 1) that already holds a document of its own. */
function daemon() {
  const workspaceDoc = new LoroDoc()
  workspaceDoc.setPeerId(1n)
  createWorkspaceDocumentAtPath(workspaceDoc, {
    path: 'own',
    documentId: DAEMON_OWN_ID,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(workspaceDoc, DAEMON_OWN_ID), '# the daemon wrote this')
  workspaceDoc.commit()
  let saves = 0
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    exists: async () => true,
    get: async () => workspaceDoc,
    save: async () => {
      saves += 1
    },
    evict() {},
    evictProjections() {},
  }
  const deps = {
    liveDocuments: new FakeLiveDocuments(),
    workspaceDocuments,
    versions: new FakeVersionHistory(),
    blobStore: new FakeBlobStore(),
  }
  return { deps, workspaceDoc, saves: () => saves }
}

describe('promoteWorkspace, carried planes', () => {
  it('stores trash bytes under the digest the entry names, and answers what the store holds', async () => {
    const target = daemon()
    const record = await browserRecord()
    const result = await promoteWorkspace(target.deps, { workspaceId: WS, operator, ...record })
    expect(result).toMatchObject({ kind: 'promoted', trashStored: [GONE_ID] })
    const [entry] = readTrashEntries(target.workspaceDoc)
    expect(entry?.documentId).toBe(GONE_ID)
    const stored = await target.deps.blobStore.get({
      ref: entry?.blob ?? { algorithm: 'sha-256', digestHex: '' },
    })
    expect(stored?.bytes).toEqual(new Uint8Array(record.trash[0]?.bytes ?? []))
  })

  it('answers only what the blob store reads back, not what it was handed', async () => {
    const target = daemon()
    const record = await browserRecord()
    // A put that resolves and keeps nothing: a lost write.
    target.deps.blobStore.put = async (input) => ({
      ref: { algorithm: 'sha-256', digestHex: await sha256Hex(input.bytes) },
    })
    const result = await promoteWorkspace(target.deps, { workspaceId: WS, operator, ...record })
    expect(result).toMatchObject({ kind: 'promoted', trashStored: [] })
  })

  it('does not answer a trash entry the daemon already held as carried', async () => {
    const target = daemon()
    const earlier = new Uint8Array([7, 7, 7])
    const { ref } = await target.deps.blobStore.put({ bytes: earlier })
    recordTrashEntry(target.workspaceDoc, {
      documentId: EARLIER_TRASH_ID,
      path: 'earlier',
      deletedAt: 0,
      blob: ref,
    })
    target.workspaceDoc.commit()
    const record = await browserRecord()
    const result = await promoteWorkspace(target.deps, { workspaceId: WS, operator, ...record })
    expect(readTrashEntries(target.workspaceDoc).map((entry) => entry.documentId)).toContain(
      EARLIER_TRASH_ID,
    )
    expect(result).toMatchObject({ kind: 'promoted', trashStored: [GONE_ID] })
  })

  it('counts the nodes of a carried canvas version from the state it names', async () => {
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: BOARD_ID, kind: 'spatial' })
    const box = (id: string) => textNode({ id, text: id, x: 0, y: 0, width: 1, height: 1 })
    writeSpatialCanvas(documentContainers(doc, BOARD_ID), {
      nodes: [box('a'), box('b')],
      edges: [],
    })
    doc.commit()
    const judged = await judgeCarried(doc, {
      trash: [],
      versions: [
        {
          id: 'board-v1',
          documentId: BOARD_ID,
          createdAt: 1,
          auto: false,
          frontiers: encodeFrontiers(doc.oplogFrontiers()),
        },
      ],
    })
    expect(judged).toMatchObject({ kind: 'admitted', versions: [{ elementCount: 2 }] })
  })

  it('a carried frontier still names the browser state in the merged record, beside the daemon own ops', async () => {
    const target = daemon()
    const record = await browserRecord()
    const result = await promoteWorkspace(target.deps, { workspaceId: WS, operator, ...record })
    expect(result).toMatchObject({ kind: 'promoted', versionsKept: ['browser-v1'] })
    const adopted = target.deps.versions.adopted.get('browser-v1')
    expect(adopted).toMatchObject({ documentId: ROADMAP_ID, label: 'as drafted', createdAt: 1_000 })
    if (adopted === undefined) return

    // Checked out of the MERGED record, which holds ops of both peers.
    const past = target.workspaceDoc.fork()
    past.checkout(adopted.frontiers)
    const content = projectWorkspaceDocument(past, ROADMAP_ID)
    expect(content === null ? null : readMarkdownBody(content)).toBe('# as drafted')
    // Derived on the daemon from that state, not taken from the sender.
    expect(adopted.contentDigest).toBe(content === null ? null : contentDigestOfDocument(content))
    // The live document is where the browser left it.
    expect(readMarkdownBody(documentContainers(target.workspaceDoc, ROADMAP_ID))).toBe(
      '# after the meeting',
    )
  })

  it.each([
    [
      'bytes that are not what the entry names',
      async () => {
        const record = await browserRecord()
        return { ...record, trash: [{ documentId: GONE_ID, bytes: new Uint8Array([1, 2, 3]) }] }
      },
    ],
    [
      'bytes for a document the record has no trash entry for',
      async () => {
        const record = await browserRecord()
        return {
          ...record,
          trash: [{ documentId: ROADMAP_ID, bytes: record.trash[0]?.bytes ?? new Uint8Array() }],
        }
      },
    ],
    [
      'a version whose frontier the record does not hold',
      async () => {
        const record = await browserRecord()
        const stranger = new LoroDoc()
        stranger.setPeerId(9n)
        stranger.getText('t').insert(0, 'elsewhere')
        stranger.commit()
        const [version] = record.versions
        if (version === undefined) throw new Error('no version')
        return {
          ...record,
          versions: [{ ...version, frontiers: encodeFrontiers(stranger.oplogFrontiers()) }],
        }
      },
    ],
    [
      'a version of a document the record did not hold at that point',
      async () => {
        const record = await browserRecord()
        const [version] = record.versions
        if (version === undefined) throw new Error('no version')
        return { ...record, versions: [{ ...version, documentId: GONE_ID }] }
      },
    ],
  ])('refuses %s, and merges nothing', async (_case, build) => {
    const target = daemon()
    const result = await promoteWorkspace(target.deps, {
      workspaceId: WS,
      operator,
      ...(await build()),
    })
    expect(result.kind).toBe('unmatched-carried')
    expect(target.saves()).toBe(0)
    expect(target.deps.blobStore.held.size).toBe(0)
    expect(target.deps.versions.adopted.size).toBe(0)
  })
})

/**
 * A record whose HEAD every sync write would take, with one version naming a
 * past state no sync write could have stored: grown in pieces each under the
 * one-write bound, and shrunk again before the record was sent.
 */
function recordWithOversizedPast(grow: (doc: LoroDoc) => void, shrink: (doc: LoroDoc) => void) {
  const doc = new LoroDoc()
  doc.setPeerId(2n)
  grow(doc)
  const oversized = encodeFrontiers(doc.oplogFrontiers())
  shrink(doc)
  return {
    snapshot: doc.export({ mode: 'snapshot' }),
    trash: [],
    versions: [
      { id: 'past-limit', documentId: ROADMAP_ID, createdAt: 1, auto: false, frontiers: oversized },
    ],
  }
}

const half = Math.ceil((MARKDOWN_MAX_CHARS + 1) / 2)
const box = (id: string) => textNode({ id, text: id, x: 0, y: 0, width: 1, height: 1 })

describe('promoteWorkspace, a carried version past a sync limit', () => {
  it.each([
    [
      'a body past the markdown limit',
      'markdown_too_large',
      () =>
        recordWithOversizedPast(
          (doc) => {
            createWorkspaceDocumentAtPath(doc, {
              path: 'roadmap',
              documentId: ROADMAP_ID,
              kind: 'markdown',
            })
            const body = documentContainers(doc, ROADMAP_ID)
            // Prepended, so no single insert is past the one-write bound.
            writeMarkdownBody(body, 'a'.repeat(half))
            writeMarkdownBody(body, 'b'.repeat(half) + 'a'.repeat(half))
          },
          (doc) => writeMarkdownBody(documentContainers(doc, ROADMAP_ID), '# short again'),
        ),
    ],
    [
      'a board past the node limit',
      'too_many_nodes_or_edges',
      () =>
        recordWithOversizedPast(
          (doc) => {
            createWorkspaceDocumentAtPath(doc, {
              path: 'roadmap',
              documentId: ROADMAP_ID,
              kind: 'spatial',
            })
            const nodes = Array.from({ length: CANVAS_MAX_NODES + 1 }, (_, i) => box(`n${i}`))
            writeSpatialCanvas(documentContainers(doc, ROADMAP_ID), { nodes, edges: [] })
            doc.commit()
          },
          (doc) => {
            writeSpatialCanvas(documentContainers(doc, ROADMAP_ID), {
              nodes: [box('kept')],
              edges: [],
            })
            doc.commit()
          },
        ),
    ],
  ])('refuses %s with the sync refusal, and merges nothing', async (_case, code, build) => {
    const target = daemon()
    const refused = await promoteWorkspace(target.deps, {
      workspaceId: WS,
      operator,
      ...build(),
    }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(TextBreachRefusalError)
    expect(refused).toMatchObject({ code, status: 413 })
    expect(target.saves()).toBe(0)
    expect(target.deps.versions.adopted.size).toBe(0)
  })
})

/**
 * The judgement's cost, counted in checkouts of the incoming record: each is
 * a move of the whole fork, followed by a projection and a size judgement of
 * the document it names, on the serving loop.
 */
describe('judgeCarried, what judging the carried versions costs', () => {
  it('counts the checkouts 1000 rows naming one frontier cost', async () => {
    const record = await browserRecord()
    const incoming = new LoroDoc()
    incoming.import(record.snapshot)
    const [version] = record.versions
    if (version === undefined) throw new Error('no version')
    const rows = Array.from({ length: 1000 }, (_, i) => ({ ...version, id: `row-${i}` }))
    const checkout = vi.spyOn(LoroDoc.prototype, 'checkout')
    try {
      const judged = await judgeCarried(incoming, { trash: [], versions: rows })
      expect(judged.kind).toBe('admitted')
      expect(checkout).toHaveBeenCalledTimes(1000)
    } finally {
      checkout.mockRestore()
    }
  })
})
