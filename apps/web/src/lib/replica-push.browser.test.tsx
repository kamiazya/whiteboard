/**
 * The return half of ADR-0023 decision 3's offline edits: ops a replica
 * took while the daemon was unreachable ship back as ordinary CRDT updates
 * through the same merge endpoint the promote uses. Real IndexedDB, and a
 * LoroDoc standing in as the daemon's record behind the update route.
 */
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { cacheDaemonWorkspace } from './replica-cache.js'
import { pushReplicaEdits } from './replica-push.js'

claimIsolatedWhiteboardDb('replica-push')

const BASE = 'http://127.0.0.1:3099'
const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const DOC_A = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const DOC_B = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

/** The daemon: snapshot GET serves `record`; update POST imports into it. */
function daemonStub(record: LoroDoc): { fetch: typeof globalThis.fetch; posts: () => number } {
  let posts = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/workspace-document/snapshot')) {
      return new Response(record.export({ mode: 'snapshot' }) as BodyInit, { status: 200 })
    }
    if (url.endsWith('/workspace-document/update') && init?.method === 'POST') {
      posts += 1
      record.import(new Uint8Array(init.body as Uint8Array))
      return Response.json({ ok: true })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, posts: () => posts }
}

async function pulledReplica(daemon: { fetch: typeof globalThis.fetch }) {
  const docs = new BrowserWorkspaceDocs()
  const pulled = await cacheDaemonWorkspace({
    fetch: daemon.fetch,
    daemonBaseUrl: BASE,
    workspaceId: DAEMON_WS,
    workspaceDocs: docs,
  })
  if (pulled.kind !== 'ok') throw new Error('pull failed')
  return { docs, syncedFrontier: pulled.syncedFrontier }
}

function daemonRecord(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes/plan', documentId: DOC_A, kind: 'markdown' })
  doc.commit()
  return doc
}

describe('pushReplicaEdits', () => {
  beforeEach(clearWhiteboardDb)

  it('ships offline ops as an update the daemon merges, and reports the new frontier', async () => {
    const target = daemonRecord()
    const daemon = daemonStub(target)
    const { docs, syncedFrontier } = await pulledReplica(daemon)

    // The offline edit: a document added while the daemon was unreachable.
    const replica = await docs.open(DAEMON_WS)
    createWorkspaceDocumentAtPath(replica!, {
      path: 'offline/note',
      documentId: DOC_B,
      kind: 'markdown',
    })
    replica!.commit()
    await docs.save(DAEMON_WS, replica!)

    const result = await pushReplicaEdits({
      fetch: daemon.fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: docs,
      syncedFrontier,
    })
    if (result.kind !== 'ok') throw new Error(`push not ok: ${JSON.stringify(result)}`)
    expect(daemon.posts()).toBe(1)
    expect(
      readWorkspaceDocuments(target)
        .map((e) => e.documentId)
        .sort(),
    ).toEqual([DOC_A, DOC_B].sort())

    // The reported frontier now covers the shipped ops: a second push with
    // it is CLEAN and sends nothing.
    const again = await pushReplicaEdits({
      fetch: daemon.fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: docs,
      syncedFrontier: result.syncedFrontier,
    })
    expect(again).toEqual({ kind: 'clean' })
    expect(daemon.posts()).toBe(1)
  })

  it('a clean replica sends nothing at all', async () => {
    const daemon = daemonStub(daemonRecord())
    const { docs, syncedFrontier } = await pulledReplica(daemon)
    const result = await pushReplicaEdits({
      fetch: daemon.fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: docs,
      syncedFrontier,
    })
    expect(result).toEqual({ kind: 'clean' })
    expect(daemon.posts()).toBe(0)
  })

  it('no recorded frontier sends the whole snapshot once — the merge makes it safe', async () => {
    const target = daemonRecord()
    const daemon = daemonStub(target)
    const { docs } = await pulledReplica(daemon)
    const result = await pushReplicaEdits({
      fetch: daemon.fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: docs,
      syncedFrontier: undefined,
    })
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(daemon.posts()).toBe(1)
    expect(readWorkspaceDocuments(target).map((e) => e.documentId)).toEqual([DOC_A])
  })

  it('a refused POST is a structured failure, and the replica is untouched', async () => {
    const daemon = daemonStub(daemonRecord())
    const { docs, syncedFrontier } = await pulledReplica(daemon)
    const replica = await docs.open(DAEMON_WS)
    createWorkspaceDocumentAtPath(replica!, {
      path: 'offline/note',
      documentId: DOC_B,
      kind: 'markdown',
    })
    replica!.commit()
    await docs.save(DAEMON_WS, replica!)

    const refusing = (async () =>
      new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch
    const result = await pushReplicaEdits({
      fetch: refusing,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: docs,
      syncedFrontier,
    })
    expect(result.kind).toBe('failed')
    const still = await docs.open(DAEMON_WS)
    expect(
      readWorkspaceDocuments(still!)
        .map((e) => e.documentId)
        .sort(),
    ).toEqual([DOC_A, DOC_B].sort())
  })

  it('a missing replica record is clean — nothing to ship', async () => {
    const result = await pushReplicaEdits({
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result).toEqual({ kind: 'clean' })
  })
})
