/**
 * The promotion library function over REAL IndexedDB: the browser keeper's
 * workspace record leaves through the same bytes the daemon route merges.
 * The daemon side of those bytes is pinned in mcp-server's
 * promote-workspace.test.ts; what this file adds is the browser half — the
 * record actually read from IndexedDB, and the posted snapshot verified by
 * importing it into a target record rather than by trusting the POST
 * happened.
 */
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { ensureLocalWorkspace } from './local-document-summary.js'
import { promoteWorkspace } from './promote-workspace.js'

claimIsolatedWhiteboardDb('promote-workspace')

const BASE = 'http://127.0.0.1:3099'
const DAEMON_OWN_ID = '01DMNAAAAAAAAAAAAAAAAAAAA0'

function targetDaemonRecord(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: 'contested',
    documentId: DAEMON_OWN_ID,
    kind: 'markdown',
  })
  doc.commit()
  return doc
}

/**
 * A daemon standing in as two fetch routes: the update POST imports the
 * posted bytes into `target` (the verification, not a mock of it), and the
 * documents list answers from the merged target with the collision's loser
 * marked shadowed — the same projection the real route serves.
 */
function daemonStub(target: LoroDoc): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/workspace-document/update') && init?.method === 'POST') {
      target.import(new Uint8Array(init.body as Uint8Array))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.endsWith('/documents')) {
      const seen = new Set<string>()
      const documents = readWorkspaceDocuments(target).map((entry) => {
        const shadowed = seen.has(entry.path)
        seen.add(entry.path)
        return {
          path: entry.path,
          id: entry.documentId,
          kind: entry.kind,
          updatedAt: new Date().toISOString(),
          ...(shadowed ? { shadowed: true as const } : {}),
        }
      })
      return new Response(JSON.stringify({ documents }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
}

describe('promoteWorkspace', () => {
  beforeEach(clearWhiteboardDb)

  it('posts the record; ids resolve on the target and the collision reports shadowed', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    const roadmap = await index.createDocument({
      workspaceId: 'local',
      path: 'notes/roadmap',
      kind: 'markdown',
    })
    const contested = await index.createDocument({
      workspaceId: 'local',
      path: 'contested',
      kind: 'spatial',
    })
    const target = targetDaemonRecord()

    const result = await promoteWorkspace({
      fetch: daemonStub(target),
      daemonBaseUrl: BASE,
      workspaceId: 'ws-a',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect([...result.promotedDocumentIds].sort()).toEqual(
      [roadmap.documentId, contested.documentId].sort(),
    )
    // Identity through the REAL posted bytes, not through the report.
    expect(resolveWorkspaceDocumentById(target, roadmap.documentId)).not.toBeNull()
    expect(resolveWorkspaceDocumentById(target, contested.documentId)).not.toBeNull()
    expect(resolveWorkspaceDocumentById(target, DAEMON_OWN_ID)).not.toBeNull()
    expect(result.shadowedPaths).toEqual(['contested'])
    expect(result.blobsPending).toBe(true)
  })

  it('a 404 target is a structured failure naming the missing daemon workspace', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    await index.createDocument({ workspaceId: 'local', path: 'doc', kind: 'markdown' })
    const fetch404 = (async () =>
      new Response(JSON.stringify({ title: 'Workspace "ws-gone" not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch

    const result = await promoteWorkspace({
      fetch: fetch404,
      daemonBaseUrl: BASE,
      workspaceId: 'ws-gone',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.reason).toContain('not found')
  })

  it('a thrown fetch is a structured network failure, never a rejection', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    await index.createDocument({ workspaceId: 'local', path: 'doc', kind: 'markdown' })
    const fetchDown = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof globalThis.fetch

    const result = await promoteWorkspace({
      fetch: fetchDown,
      daemonBaseUrl: BASE,
      workspaceId: 'ws-a',
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('failed')
  })
})
