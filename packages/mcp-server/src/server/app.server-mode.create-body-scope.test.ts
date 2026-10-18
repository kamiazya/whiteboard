/**
 * A document's BODY is `canvas:write`'s to write on every surface, the create
 * included. `workspace:write` places documents — creates, moves, deletes —
 * and a create that carries markdown writes content as well, so a grant that
 * may place documents and not write content gets the empty create only.
 * Driven through server mode's whole `/api`, so the route's own scope and the
 * membership gate in front of it are the real ones.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
let bearerScopes: readonly AuthScope[] = []

// A bearer naming `SUBJECT`, held to `bearerScopes` the way the OAuth
// strategy holds a real token to its scopes.
const scopedBearer: AsyncAuthStrategy = {
  async authorize({ authorizationHeader, requiredScopes }) {
    if (authorizationHeader !== `Bearer ${SUBJECT}`) {
      return { ok: false, status: 401, code: 'auth.required', wwwAuthenticate: 'Bearer' }
    }
    if (!hasRequiredScopes(bearerScopes, requiredScopes)) {
      return { ok: false, status: 403, code: 'auth.forbidden' }
    }
    return {
      ok: true,
      context: { kind: 'oauth-resource-server', subject: SUBJECT, scopes: bearerScopes },
      person: { authenticator: ISSUER, subject: SUBJECT },
    }
  },
}

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-create-body-scope-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const stores = serverModePeople(handle.db, tempDir)
  members = stores.members
  sessions = stores.sessions
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: scopedBearer,
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
  bearerScopes = []
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

const BEARER = { authorization: `Bearer ${SUBJECT}` }

/** `SUBJECT` signed in, owning an empty workspace made by the session. */
async function ownWorkspace(): Promise<string> {
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
  return ((await created.json()) as { workspaceId: string }).workspaceId
}

function create(workspaceId: string, body: Record<string, unknown>) {
  return app.request(`${PUBLIC_URL}/api/v1/workspaces/${workspaceId}/documents`, {
    method: 'POST',
    headers: { ...BEARER, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function listedPaths(workspaceId: string): Promise<string[]> {
  const listed = await app.request(`${PUBLIC_URL}/api/v1/workspaces/${workspaceId}/documents`, {
    headers: BEARER,
  })
  expect(listed.status).toBe(200)
  const { documents } = (await listed.json()) as { documents: { path: string }[] }
  return documents.map((entry) => entry.path)
}

describe('server mode — creating a document through /api/v1', () => {
  it('refuses a body to a grant without canvas:write, and writes nothing', async () => {
    const workspaceId = await ownWorkspace()
    bearerScopes = ['workspace:read', 'workspace:write']

    const res = await create(workspaceId, { path: 'plan', kind: 'markdown', markdown: '# Plan' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('insufficient_scope')
    expect(await listedPaths(workspaceId)).not.toContain('plan')
  })

  it('creates an empty document with workspace:write alone', async () => {
    const workspaceId = await ownWorkspace()
    bearerScopes = ['workspace:read', 'workspace:write']

    expect((await create(workspaceId, { path: 'empty', kind: 'markdown' })).status).toBe(201)
    expect((await create(workspaceId, { path: 'board', kind: 'spatial' })).status).toBe(201)
  })

  it('creates the document with its body once canvas:write is added', async () => {
    const workspaceId = await ownWorkspace()
    bearerScopes = ['workspace:read', 'workspace:write', 'canvas:write']

    const res = await create(workspaceId, { path: 'plan', kind: 'markdown', markdown: '# Plan' })
    expect(res.status).toBe(201)
    expect(await listedPaths(workspaceId)).toContain('plan')
  })
})
