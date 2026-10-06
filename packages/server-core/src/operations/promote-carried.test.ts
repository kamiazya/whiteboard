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
} from '@kamiazya/whiteboard-loro-adapter'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { WorkspaceDocuments } from '../server-deps.js'
import { FakeBlobStore } from '../test-utils/fake-blob-store.js'
import { FakeLiveDocuments } from '../test-utils/fake-live-documents.js'
import { FakeVersionHistory } from '../test-utils/fake-version-history.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { promoteWorkspace } from './promote-workspace.js'

const WS = 'ws-1'
const ROADMAP_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const GONE_ID = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const DAEMON_OWN_ID = '01BRWAAAAAAAAAAAAAAAAAAAA3'
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
