/**
 * ADR-0046 decisions 1 and 10 on server mode's `/api`: a request's person is
 * the session a sign-in opened, or else the subject a bearer token names; and
 * every workspace-addressed route is members-only from the start.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { ALL_AUTH_SCOPES } from './auth-strategy.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'
import type { AsyncAuthStrategy } from './oauth-resource-strategy.js'
import { createServerModeApiAuthMiddleware } from './server-mode-middleware.js'
import {
  createSignInSessionStore,
  SESSION_COOKIE,
  type SignInSessionStore,
} from './sign-in-session-store.js'

const WS = 'ws-plans'
const ISSUER = 'oidc:https://idp.test'

// "Bearer <sub>" names that subject; "Bearer anonymous" is a valid token that
// names no person (a client-credentials token, say).
const strategy: AsyncAuthStrategy = {
  async authorize({ authorizationHeader }) {
    const sub = authorizationHeader?.replace(/^Bearer /, '')
    if (sub === undefined || sub === '') {
      return { ok: false, status: 401, code: 'auth.required', wwwAuthenticate: 'Bearer' }
    }
    return {
      ok: true,
      context: {
        kind: 'oauth-resource-server',
        subject: sub,
        scopes: ALL_AUTH_SCOPES,
      },
      ...(sub === 'anonymous' ? {} : { person: { authenticator: ISSUER, subject: sub } }),
    }
  },
}

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let app: Hono

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-server-mode-people-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  sessions = createSignInSessionStore(handle.db)
  app = new Hono()
  app.use('/api/*', createServerModeApiAuthMiddleware(strategy, { members, sessions }))
  app.get('/api/workspaces/:workspaceId/documents', (c) => c.json({ reached: true }))
  app.post('/api/runtime/logs/prune', (c) => c.json({ reached: true }))
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

async function member(subject: string) {
  const profile = await members.ensureProfile({
    binding: { authenticator: ISSUER, subject },
    displayName: subject,
  })
  await members.addMember(WS, profile.id)
}

const documents = (headers: Record<string, string>) =>
  app.request(`/api/workspaces/${WS}/documents`, { headers })

describe('server mode — who is asking, and are they a member', () => {
  it('refuses a valid bearer for a workspace nobody has joined', async () => {
    const res = await documents({ authorization: 'Bearer ada' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('not_a_member')
  })

  it("admits a member's bearer", async () => {
    await member('ada')
    expect((await documents({ authorization: 'Bearer ada' })).status).toBe(200)
  })

  it('admits a member signed in at this host, with no bearer at all', async () => {
    await member('ada')
    const token = await sessions.create(
      { authenticator: ISSUER, subject: 'ada' },
      Date.now(),
      60_000,
    )
    expect((await documents({ cookie: `${SESSION_COOKIE}=${token}` })).status).toBe(200)
  })

  // A browser session is a person, not an operator: the keeper's admin
  // routes stay with credentials the operator scopes for them.
  it('refuses an admin route to a signed-in session', async () => {
    const token = await sessions.create(
      { authenticator: ISSUER, subject: 'ada' },
      Date.now(),
      60_000,
    )
    const res = await app.request('/api/runtime/logs/prune', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'auth.forbidden' })
  })

  it('treats an unknown session as no session', async () => {
    await member('ada')
    expect((await documents({ cookie: `${SESSION_COOKIE}=forged` })).status).toBe(401)
  })

  it('asks for a person when a valid bearer names nobody', async () => {
    const res = await documents({ authorization: 'Bearer anonymous' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('requires_person_session')
  })

  it("does not let one member's session into another's workspace", async () => {
    await member('ada')
    const token = await sessions.create(
      { authenticator: ISSUER, subject: 'eve' },
      Date.now(),
      60_000,
    )
    expect((await documents({ cookie: `${SESSION_COOKIE}=${token}` })).status).toBe(403)
  })
})
