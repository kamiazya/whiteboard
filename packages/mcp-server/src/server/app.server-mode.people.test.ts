/**
 * ADR-0046 decisions 1 and 10, through server mode's whole `/api`: a person is
 * who a session or bearer names, every workspace is members-only from the
 * start, and the person who creates one is its first member.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import type { ServerModeAppOptions } from './app.js'
import { ALL_AUTH_SCOPES } from './security/auth-strategy.js'
import {
  createMemberProfileStore,
  type MemberProfileStore,
} from './security/member-profile-store.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import {
  createSignInSessionStore,
  SESSION_COOKIE,
  type SignInSessionStore,
} from './security/sign-in-session-store.js'
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

const ISSUER = 'oidc:https://idp.test'
const PUBLIC_URL = 'https://example.com'

const bearerNamesItsSubject: AsyncAuthStrategy = {
  async authorize({ authorizationHeader }) {
    const sub = authorizationHeader?.replace(/^Bearer /, '')
    if (!sub) return { ok: false, status: 401, code: 'auth.required', wwwAuthenticate: 'Bearer' }
    return {
      ok: true,
      context: {
        kind: 'oauth-resource-server',
        subject: sub,
        scopes: ALL_AUTH_SCOPES,
        person: { authenticator: ISSUER, subject: sub },
      },
    }
  },
}

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-people-app-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  members = createMemberProfileStore(handle.db)
  sessions = createSignInSessionStore(handle.db)
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps: resolveServerDeps(createContainer()),
    people: { members, sessions },
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

/** A person signed in at this host: a user in the tenant, and a session. */
async function signedIn(subject: string): Promise<Record<string, string>> {
  const binding = { authenticator: ISSUER, subject }
  await members.ensureProfile({ binding, displayName: subject })
  const token = await sessions.create(binding, Date.now(), 60_000)
  return { cookie: `${SESSION_COOKIE}=${token}` }
}

async function create(headers: Record<string, string>, displayName: string) {
  return app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
}

async function listed(headers: Record<string, string>): Promise<string[]> {
  const res = await app.request(`${PUBLIC_URL}/api/workspaces`, { headers })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { workspaces: { displayName?: string }[] }
  return body.workspaces.map((w) => w.displayName ?? '')
}

describe('server mode — a workspace belongs to the people in it', () => {
  it('makes the creator its first member, and shows it to nobody else', async () => {
    const ada = await signedIn('ada')
    const eve = await signedIn('eve')
    const res = await create(ada, 'Plans')
    expect(res.status).toBe(201)
    const { workspaceId } = (await res.json()) as { workspaceId: string }

    expect(await listed(ada)).toEqual(['Plans'])
    expect(await listed(eve)).toEqual([])
    const read = (headers: Record<string, string>) =>
      app.request(`${PUBLIC_URL}/api/workspaces/${workspaceId}/documents`, { headers })
    expect((await read(ada)).status).toBe(200)
    expect((await read(eve)).status).toBe(403)
  })

  // Without a user here there is nobody to make the first member, and a
  // workspace with no member would be one nobody can open.
  it('refuses to create a workspace for a bearer that is no user of this tenant', async () => {
    const res = await create({ authorization: 'Bearer stranger' }, 'Orphan')
    expect(res.status).toBe(403)
    expect(await listed({ authorization: 'Bearer stranger' })).toEqual([])
  })
})
