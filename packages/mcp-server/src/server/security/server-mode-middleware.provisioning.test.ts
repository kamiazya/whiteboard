/**
 * ADR-0046 decision 5 at server mode's `/api`: a bearer whose person has no
 * user yet becomes one through the provider declared for its issuer, or is
 * refused by that provider's reason — before any route answers.
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
import { providerAuthenticator, signInConfigSchema } from './sign-in-config.js'
import { createSignInSessionStore, SESSION_COOKIE } from './sign-in-session-store.js'
import { createUserDeactivation } from './user-deactivation.js'

const ISSUER = 'https://idp.test'

// "Bearer <client>:<sub>" — a verified, typed token from that client naming that subject.
function strategyFor(issuer: string): AsyncAuthStrategy {
  return {
    async authorize({ authorizationHeader }) {
      const [client, sub] = (authorizationHeader ?? '').replace(/^Bearer /, '').split(':')
      if (client === undefined || sub === undefined) {
        return { ok: false, status: 401, code: 'auth.required', wwwAuthenticate: 'Bearer' }
      }
      return {
        ok: true,
        context: { kind: 'oauth-resource-server', subject: sub, scopes: ALL_AUTH_SCOPES },
        person: { authenticator: providerAuthenticator({ issuer }), subject: sub },
        bearer: () => ({ typed: true, claims: { sub, azp: client, name: sub } }),
      }
    },
  }
}

const providers = signInConfigSchema.parse({
  providers: [
    {
      id: 'corp',
      kind: 'oidc',
      issuer: ISSUER,
      clientId: 'wb-web',
      clientSecret: { env: 'CORP_SECRET' },
      admission: { createAccounts: true, bearerClients: ['claude-code'] },
    },
  ],
}).providers

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore

function appFor(issuer: string) {
  const app = new Hono()
  const sessions = createSignInSessionStore(handle.db)
  app.use(
    '/api/*',
    createServerModeApiAuthMiddleware(strategyFor(issuer), {
      members,
      sessions,
      bearerProvisioning: { providers, members },
    }),
  )
  app.get('/api/workspaces', (c) => c.json({ reached: true }))
  return app
}

const userFor = (issuer: string, subject: string) =>
  members.profileForBinding({ authenticator: providerAuthenticator({ issuer }), subject })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-server-mode-provisioning-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('server mode — a bearer becoming a user', () => {
  it('creates the user on the first request from a client the provider names', async () => {
    const res = await appFor(ISSUER).request('/api/workspaces', {
      headers: { authorization: 'Bearer claude-code:ada' },
    })
    expect(res.status).toBe(200)
    expect((await userFor(ISSUER, 'ada'))?.displayName).toBe('ada')
  })

  it("refuses, by the provider's reason, a client it does not name", async () => {
    const res = await appFor(ISSUER).request('/api/workspaces', {
      headers: { authorization: 'Bearer other-app:ada' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'client_not_allowed' })
    expect(await userFor(ISSUER, 'ada')).toBeNull()
  })

  it('leaves a bearer from an undeclared issuer without a user, as before', async () => {
    const other = 'https://other.test'
    const res = await appFor(other).request('/api/workspaces', {
      headers: { authorization: 'Bearer other-app:ada' },
    })
    expect(res.status).toBe(200)
    expect(await userFor(other, 'ada')).toBeNull()
  })

  // Only creation is decided at the bearer; an existing user is not
  // re-admitted per request, like a session between sign-ins.
  it('does not re-admit a person who already has a user', async () => {
    await members.ensureProfile({
      binding: { authenticator: providerAuthenticator({ issuer: ISSUER }), subject: 'ada' },
      displayName: 'Ada',
    })
    const res = await appFor(ISSUER).request('/api/workspaces', {
      headers: { authorization: 'Bearer other-app:ada' },
    })
    expect(res.status).toBe(200)
  })
})

// ADR-0049 decision 4: a deactivated user is refused before any route, by a
// bearer and by a session alike.
describe('server mode — a deactivated user', () => {
  const binding = { authenticator: providerAuthenticator({ issuer: ISSUER }), subject: 'ada' }

  it('refuses their bearer, and does not make them a new user', async () => {
    const user = await members.ensureProfile({ binding, displayName: 'Ada' })
    await createUserDeactivation(handle.db).deactivate(user.id, 1)
    const res = await appFor(ISSUER).request('/api/workspaces', {
      headers: { authorization: 'Bearer claude-code:ada' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'deactivated' })
    expect(await members.isDeactivated(binding)).toBe(true)
  })

  it('refuses a session that outlived the deactivation', async () => {
    const user = await members.ensureProfile({ binding, displayName: 'Ada' })
    await createUserDeactivation(handle.db).deactivate(user.id, 1)
    // Deactivating ends the sessions it can see; this one stands for a
    // sign-in that completed in the same moment.
    const token = await createSignInSessionStore(handle.db).create(binding, Date.now(), 60_000)
    const res = await appFor(ISSUER).request('/api/workspaces', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'deactivated' })
  })
})
