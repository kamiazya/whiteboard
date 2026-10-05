import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentEngineTrapError } from '../document-io.js'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { FakeLiveDocuments } from '../test-utils/fake-live-documents.js'
import { FakeVersionHistory } from '../test-utils/fake-version-history.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { promoteWorkspace } from './promote-workspace.js'
import { OffGrammarPathError } from './sync-write-refusals.js'

const WS = 'ws-1'
const ROADMAP_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const SKETCH_ID = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const CONTESTED_ID = '01BRWAAAAAAAAAAAAAAAAAAAA2'
const DAEMON_OWN_ID = '01BRWAAAAAAAAAAAAAAAAAAAA3'

const attestation = {
  kind: 'webauthn' as const,
  credentialId: 'Y3JlZA',
  authenticatorData: 'YXV0aA',
  clientDataJSON: 'Y2xpZW50',
  signature: 'c2ln',
}
const operator = { kind: 'human' as const, displayName: 'Yuki' }

/**
 * Who wins a contested path is the tree's sibling order: position first,
 * then the lower peer id (measured with a probe over both orderings). The
 * daemon takes peer 1 and the browser 2 by default, so the INCOMING contested
 * document is the shadowed one; the third case swaps them.
 */
function browserRecord(peer = 2n): Uint8Array {
  const doc = new LoroDoc()
  doc.setPeerId(peer)
  // Created FIRST on both sides, so the two contested nodes tie on position
  // and the peer id alone decides — a node created after siblings sorts
  // after them regardless of peer (measured).
  createWorkspaceDocumentAtPath(doc, {
    path: 'contested',
    documentId: CONTESTED_ID,
    kind: 'markdown',
  })
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/roadmap',
    documentId: ROADMAP_ID,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(doc, ROADMAP_ID), '# roadmap v1')
  createWorkspaceDocumentAtPath(doc, { path: 'sketch', documentId: SKETCH_ID, kind: 'spatial' })
  doc.commit()
  return doc.export({ mode: 'snapshot' }) as Uint8Array
}

/** A daemon workspace that already holds its own documents, one at a path the record also uses. */
function fakes(peer = 1n) {
  const workspaceDoc = new LoroDoc()
  workspaceDoc.setPeerId(peer)
  createWorkspaceDocumentAtPath(workspaceDoc, {
    path: 'contested',
    documentId: DAEMON_OWN_ID,
    kind: 'markdown',
  })
  workspaceDoc.commit()
  const live = new FakeLiveDocuments()
  const versions = new FakeVersionHistory()
  let saves = 0
  let evictions = 0
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    async exists() {
      return true
    },
    async get() {
      return workspaceDoc
    },
    async save() {
      saves += 1
    },
    evict() {
      evictions += 1
    },
    evictProjections() {},
  }
  return {
    live: live as LiveDocuments,
    versions,
    workspaceDocuments,
    workspaceDoc,
    saves: () => saves,
    evictions: () => evictions,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('promoteWorkspace', () => {
  it('merges the record and writes one explicit human checkpoint per promoted document, carrying the attestation', async () => {
    const fake = fakes()
    const result = await promoteWorkspace(
      {
        liveDocuments: fake.live,
        workspaceDocuments: fake.workspaceDocuments,
        versions: fake.versions,
      },
      { workspaceId: WS, snapshot: browserRecord(), operator, attestation },
    )
    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') return
    expect([...result.recorded].sort()).toEqual([ROADMAP_ID, SKETCH_ID])
    expect(result.shadowed).toEqual([CONTESTED_ID])
    expect(fake.saves()).toBe(1)
    // The merge landed: the record's body is readable in the workspace doc.
    expect(readMarkdownBody(documentContainers(fake.workspaceDoc, ROADMAP_ID))).toBe('# roadmap v1')

    // One row per promoted document, explicit, human, with the evidence.
    expect(fake.versions.saves.map((save) => save.path).sort()).toEqual(['notes/roadmap', 'sketch'])
    for (const save of fake.versions.saves) {
      expect(save.options).toEqual({ auto: false, operator, attestation })
    }
  })

  it("writes the rows without an attestation when none was asked for, and none for the target's own documents", async () => {
    const fake = fakes()
    const result = await promoteWorkspace(
      {
        liveDocuments: fake.live,
        workspaceDocuments: fake.workspaceDocuments,
        versions: fake.versions,
      },
      { workspaceId: WS, snapshot: browserRecord(), operator },
    )
    expect(result.kind).toBe('promoted')
    expect(fake.versions.saves).toHaveLength(2)
    for (const save of fake.versions.saves) {
      expect(save.options).toEqual({ auto: false, operator })
      expect(save.path).not.toBe('contested')
    }
  })

  it("when the promoted document wins the contested path it gets the row and the target's own does not", async () => {
    const fake = fakes(2n)
    const result = await promoteWorkspace(
      {
        liveDocuments: fake.live,
        workspaceDocuments: fake.workspaceDocuments,
        versions: fake.versions,
      },
      { workspaceId: WS, snapshot: browserRecord(1n), operator },
    )
    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') return
    expect([...result.recorded].sort()).toEqual([ROADMAP_ID, SKETCH_ID, CONTESTED_ID])
    expect(result.shadowed).toEqual([])
    expect(fake.versions.saves.map((save) => save.path).sort()).toEqual([
      'contested',
      'notes/roadmap',
      'sketch',
    ])
  })

  it('refuses bytes that are not a Loro snapshot before touching the workspace', async () => {
    const fake = fakes()
    const result = await promoteWorkspace(
      {
        liveDocuments: fake.live,
        workspaceDocuments: fake.workspaceDocuments,
        versions: fake.versions,
      },
      { workspaceId: WS, snapshot: new Uint8Array([1, 2, 3, 4]), operator },
    )
    expect(result).toEqual({ kind: 'malformed-snapshot' })
    expect(fake.saves()).toBe(0)
    expect(fake.versions.saves).toEqual([])
  })

  it('an engine trap in the merge drops the target record and is not called malformed', async () => {
    const fake = fakes()
    vi.spyOn(fake.workspaceDoc, 'import').mockImplementation(() => {
      throw Object.assign(new Error('unreachable'), { name: 'RuntimeError' })
    })
    const dropped: string[] = []
    const failure = await promoteWorkspace(
      {
        liveDocuments: fake.live,
        workspaceDocuments: {
          ...fake.workspaceDocuments,
          evict: () => dropped.push('record'),
          evictProjections: () => dropped.push('projections'),
        },
        versions: fake.versions,
      },
      { workspaceId: WS, snapshot: browserRecord(), operator },
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(DocumentEngineTrapError)
    expect(dropped).toEqual(['record', 'projections'])
    expect(fake.saves()).toBe(0)
    expect(fake.versions.saves).toEqual([])
  })

  it('an engine trap on the incoming record is not called malformed either', async () => {
    const fake = fakes()
    // The first import promote makes is into its own throwaway copy of the record.
    vi.spyOn(LoroDoc.prototype, 'import').mockImplementationOnce(() => {
      throw Object.assign(new Error('unreachable'), { name: 'RuntimeError' })
    })
    const failure = await promoteWorkspace(
      {
        liveDocuments: fake.live,
        workspaceDocuments: fake.workspaceDocuments,
        versions: fake.versions,
      },
      { workspaceId: WS, snapshot: browserRecord(), operator },
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(DocumentEngineTrapError)
    expect(fake.saves()).toBe(0)
  })

  it('refuses a record holding a path outside the document-path grammar and merges none of it', async () => {
    const fake = fakes()
    const record = new LoroDoc()
    record.setPeerId(2n)
    createWorkspaceDocumentAtPath(record, {
      path: 'sketch',
      documentId: SKETCH_ID,
      kind: 'spatial',
    })
    createWorkspaceDocumentAtPath(record, {
      path: 'Meeting notes',
      documentId: ROADMAP_ID,
      kind: 'markdown',
    })
    record.commit()
    const refusal = await promoteWorkspace(
      {
        liveDocuments: fake.live,
        workspaceDocuments: fake.workspaceDocuments,
        versions: fake.versions,
      },
      { workspaceId: WS, snapshot: record.export({ mode: 'snapshot' }), operator },
    ).catch((err: unknown) => err)
    // The merge's own refusal: one judgement of a path for promote and sync alike.
    expect(refusal).toBeInstanceOf(OffGrammarPathError)
    expect(refusal).toMatchObject({ paths: ['Meeting notes'] })
    // Nothing saved, and the instance the merge touched is dropped, so the
    // next read rebuilds the record from what was stored.
    expect(fake.saves()).toBe(0)
    expect(fake.evictions()).toBe(1)
    expect(fake.versions.saves).toEqual([])
  })
})
