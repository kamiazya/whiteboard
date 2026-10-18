/**
 * Adding, removing and moving documents is `workspace:write`'s, on the raw
 * sync routes as on the document API: a grant holding `canvas:write` alone
 * edits what documents say and changes nothing about which documents a
 * workspace holds. Driven through server mode's whole `/api`, so the scope
 * the route is entered with and the one the update is judged by are both the
 * real ones.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteWorkspaceDocument,
  documentContainers,
  readSpatialCanvas,
  resolveWorkspaceDocument,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ISSUER, PUBLIC_URL, serverModePeople } from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { resolveTestServerDeps, testDataLayout } from './routes/_test-helpers.js'
import { type AuthScope, hasRequiredScopes } from './security/auth-strategy.js'
import type { MemberProfileStore } from './security/member-profile-store.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import { SESSION_COOKIE, type SignInSessionStore } from './security/sign-in-session-store.js'
import { createIsolatedDb } from './store/db/test-helpers.js'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('./app.js')

const SUBJECT = 'ada'
const EDITOR_SCOPES: readonly AuthScope[] = ['canvas:read', 'canvas:write']

// A bearer naming `SUBJECT`, scoped to edit content only, and held to its
// scopes the way the OAuth strategy holds a real token to them.
const contentOnlyBearer: AsyncAuthStrategy = {
  async authorize({ authorizationHeader, requiredScopes }) {
    if (authorizationHeader !== `Bearer ${SUBJECT}`) {
      return { ok: false, status: 401, code: 'auth.required', wwwAuthenticate: 'Bearer' }
    }
    if (!hasRequiredScopes(EDITOR_SCOPES, requiredScopes)) {
      return { ok: false, status: 403, code: 'auth.forbidden' }
    }
    return {
      ok: true,
      context: { kind: 'oauth-resource-server', subject: SUBJECT, scopes: EDITOR_SCOPES },
      person: { authenticator: ISSUER, subject: SUBJECT },
    }
  },
}

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-placement-scope-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const stores = serverModePeople(handle.db, tempDir)
  members = stores.members
  sessions = stores.sessions
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: contentOnlyBearer,
    serverDeps: await resolveTestServerDeps(tempDir),
    dataLayout: testDataLayout(),
    people: stores.people,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  app = createApp(options)
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

const BEARER = { authorization: `Bearer ${SUBJECT}` }

function canvasUpdate(ids: readonly string[]): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const from = doc.version()
  writeSpatialCanvas(doc, {
    nodes: ids.map((id) => textNode({ id, text: id, x: 0, y: 0, width: 10, height: 10 })),
    edges: [],
  })
  return new Uint8Array(doc.export({ mode: 'update', from }))
}

function post(path: string, headers: Record<string, string>, body: Uint8Array<ArrayBuffer>) {
  return app.request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    body,
  })
}

/**
 * `SUBJECT` signed in, owning a workspace that holds the spatial document
 * `notes` — made by the session, which holds every scope a person does.
 */
async function workspaceWithNotes() {
  const binding = { authenticator: ISSUER, subject: SUBJECT }
  await members.ensureProfile({ binding, displayName: SUBJECT })
  const token = await sessions.create(binding, Date.now(), 60_000, Date.now())
  const session = { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL }
  const created = await app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...session, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: SUBJECT }),
  })
  expect(created.status).toBe(201)
  const { workspaceId } = (await created.json()) as { workspaceId: string }
  const made = await post(
    `/api/w/${workspaceId}/document/notes/update`,
    session,
    canvasUpdate(['a']),
  )
  expect(made.status).toBe(200)
  return workspaceId
}

async function workspaceRecord(workspaceId: string): Promise<LoroDoc> {
  const res = await app.request(`${PUBLIC_URL}/api/w/${workspaceId}/workspace-document/snapshot`, {
    headers: BEARER,
  })
  expect(res.status).toBe(200)
  const doc = new LoroDoc()
  doc.import(new Uint8Array(await res.arrayBuffer()))
  return doc
}

/** What `edit` does to a replica of the workspace record, as an update. */
async function recordUpdate(workspaceId: string, edit: (replica: LoroDoc) => void) {
  const replica = await workspaceRecord(workspaceId)
  const from = replica.oplogVersion()
  edit(replica)
  replica.commit()
  return new Uint8Array(replica.export({ mode: 'update', from }))
}

function notesId(record: LoroDoc): string {
  const entry = resolveWorkspaceDocument(record, 'notes')
  if (entry === null) throw new Error('notes is not in the workspace')
  return entry.documentId
}

describe('server mode — a canvas:write grant without workspace:write', () => {
  it('cannot delete a document through the workspace-document update', async () => {
    const workspaceId = await workspaceWithNotes()
    const update = await recordUpdate(workspaceId, (replica) =>
      deleteWorkspaceDocument(replica, { documentId: notesId(replica) }),
    )

    const res = await post(`/api/w/${workspaceId}/workspace-document/update`, BEARER, update)

    expect(res.status).toBe(403)
    expect(resolveWorkspaceDocument(await workspaceRecord(workspaceId), 'notes')).not.toBeNull()
  })

  it('cannot mint a document by updating a path nobody holds', async () => {
    const workspaceId = await workspaceWithNotes()

    const res = await post(
      `/api/w/${workspaceId}/document/fresh/update`,
      BEARER,
      canvasUpdate(['b']),
    )

    expect(res.status).toBe(403)
    expect(resolveWorkspaceDocument(await workspaceRecord(workspaceId), 'fresh')).toBeNull()
  })

  // A document's content and its node's own meta share one map on the tree
  // node, so a root named after a meta key would rewrite the node from a
  // grant that may only edit content.
  it.each([
    ['a map named nameChosen', (doc: LoroDoc) => doc.getMap('nameChosen').set('x', 1)],
    ['a text named name', (doc: LoroDoc) => doc.getText('name').insert(0, 'n'.repeat(5000))],
    ['a text named kind', (doc: LoroDoc) => doc.getText('kind').insert(0, 'markdown')],
    ['a text where content holds a map', (doc: LoroDoc) => doc.getText('nodes').insert(0, 'x')],
  ])('refuses a per-document update adding %s, and the document stays listed', async (_, add) => {
    const workspaceId = await workspaceWithNotes()
    const doc = new LoroDoc()
    add(doc)
    doc.commit()

    const res = await post(
      `/api/w/${workspaceId}/document/notes/update`,
      BEARER,
      new Uint8Array(doc.export({ mode: 'update' })),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_document_root' })
    const entry = resolveWorkspaceDocument(await workspaceRecord(workspaceId), 'notes')
    expect(entry).not.toBeNull()
    expect(entry?.name).toBeUndefined()
    expect(entry?.kind).toBe('spatial')
  })

  it('still edits a document’s content through either update route', async () => {
    const workspaceId = await workspaceWithNotes()

    const perDocument = await post(
      `/api/w/${workspaceId}/document/notes/update`,
      BEARER,
      canvasUpdate(['b']),
    )
    expect(perDocument.status).toBe(200)

    const update = await recordUpdate(workspaceId, (replica) => {
      const canvas = readSpatialCanvas(documentContainers(replica, notesId(replica)))
      writeSpatialCanvas(documentContainers(replica, notesId(replica)), {
        ...canvas,
        nodes: [
          ...canvas.nodes,
          textNode({ id: 'c', text: 'c', x: 0, y: 0, width: 10, height: 10 }),
        ],
      })
    })
    const whole = await post(`/api/w/${workspaceId}/workspace-document/update`, BEARER, update)
    expect(whole.status).toBe(200)

    const record = await workspaceRecord(workspaceId)
    const ids = readSpatialCanvas(documentContainers(record, notesId(record))).nodes.map(
      (n) => n.id,
    )
    expect(ids.sort()).toEqual(['a', 'b', 'c'])
  })
})
