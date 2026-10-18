/**
 * What a document SAYS is `canvas:read`'s on every surface. `workspace:read`
 * lists documents and resolves their ids; it does not read their content, on
 * the document API any more than on the snapshot route or `/mcp`. Driven
 * through server mode's whole `/api`, so the scope the route asks for and the
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
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-content-read-scope-'))
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
const SECRET = 'quarterly-figures-zebra'

/**
 * `SUBJECT` signed in, owning a workspace that holds the markdown document
 * `plan` — made by the session, which holds every scope a person does.
 */
async function workspaceWithPlan(): Promise<{ workspaceId: string; documentId: string }> {
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
  const made = await app.request(`${PUBLIC_URL}/api/v1/workspaces/${workspaceId}/documents`, {
    method: 'POST',
    headers: { ...session, 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'plan', kind: 'markdown', markdown: `The ${SECRET} live here.` }),
  })
  expect(made.status).toBe(201)
  const { documentId } = (await made.json()) as { documentId: string }
  return { workspaceId, documentId }
}

function get(path: string) {
  return app.request(`${PUBLIC_URL}${path}`, { headers: BEARER })
}

describe('server mode — a workspace:read grant without canvas:read', () => {
  it('lists the document but reads none of its content', async () => {
    const { workspaceId, documentId } = await workspaceWithPlan()
    bearerScopes = ['workspace:read']

    const listed = await get(`/api/v1/workspaces/${workspaceId}/documents`)
    expect(listed.status).toBe(200)

    const okf = await get(`/api/v1/workspaces/${workspaceId}/documents/${documentId}/okf`)
    expect(okf.status).toBe(403)
    expect(await okf.text()).not.toContain(SECRET)

    const search = await get(`/api/v1/workspaces/${workspaceId}/search?q=${SECRET}`)
    expect(search.status).toBe(403)
    expect(await search.text()).not.toContain(SECRET)
  })

  it('reads the content once canvas:read is added', async () => {
    const { workspaceId, documentId } = await workspaceWithPlan()
    bearerScopes = ['workspace:read', 'canvas:read']

    const okf = await get(`/api/v1/workspaces/${workspaceId}/documents/${documentId}/okf`)
    expect(okf.status).toBe(200)
    expect(await okf.text()).toContain(SECRET)

    const search = await get(`/api/v1/workspaces/${workspaceId}/search?q=${SECRET}`)
    expect(search.status).toBe(200)
    expect(await search.text()).toContain(SECRET)
  })
})
