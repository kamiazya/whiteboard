import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import type { CredentialResolver, ResolvedGrant } from '../security/credential-resolver.js'
import { createMemberProfileStore, passkeyBinding } from '../security/member-profile-store.js'
import { membershipAdmit } from '../security/membership-gate.js'
import { createIsolatedDb, type IsolatedDbHandle } from '../store/db/test-helpers.js'
import { createDaemonAuthMiddleware, requiresDaemonAuth } from './auth.js'

describe('requiresDaemonAuth', () => {
  it('default-requires bearer auth for every /api method, not just mutations', () => {
    expect(requiresDaemonAuth('/api/workspaces/session-1/documents')).toBe(true)
    expect(requiresDaemonAuth('/api/brand-new-mutation')).toBe(true)
    // Reads are gated like writes: a narrower credential is held to its scopes
    // on a read too, and the client already sends its bearer on every read.
    expect(requiresDaemonAuth('/api/workspaces')).toBe(true)
    expect(requiresDaemonAuth('/api/w/session-1/document/demo/snapshot')).toBe(true)
    expect(
      requiresDaemonAuth('/api/workspaces/session-1/documents/demo/versions/v1/thumbnail'),
    ).toBe(true)
    expect(requiresDaemonAuth('/api/w/session-1/document/demo/file/f1')).toBe(true)
  })

  it('gates every /api path, leaving which of them are public to the route-scope registry alone', () => {
    expect(requiresDaemonAuth('/api/runtime/ping')).toBe(true)
    expect(requiresDaemonAuth('/api/runtime/status')).toBe(true)
    expect(requiresDaemonAuth('/api/runtime/storage')).toBe(true)
    expect(requiresDaemonAuth('/api/runtime/brand-new')).toBe(true)
  })

  it('leaves non-/api paths alone', () => {
    expect(requiresDaemonAuth('/document/session-1/demo')).toBe(false)
    expect(requiresDaemonAuth('/')).toBe(false)
  })
})

describe('createDaemonAuthMiddleware public routes', () => {
  const refusesEveryone: CredentialResolver = { resolve: async () => null }
  const appRefusingEveryone = () => {
    const app = new Hono()
    app.use('/api/*', createDaemonAuthMiddleware(refusesEveryone))
    app.all('/api/*', (c) => c.json({ reached: true }))
    return app
  }

  it('lets /api/runtime/ping through with no credential, by the registry alone', async () => {
    const res = await appRefusingEveryone().request('/api/runtime/ping')
    expect(res.status).toBe(200)
  })

  it('refuses a sibling runtime path with no credential', async () => {
    const res = await appRefusingEveryone().request('/api/runtime/status')
    expect(res.status).toBe(401)
  })
})

describe('membershipAdmit', () => {
  let dir: string | undefined
  let dbHandle: IsolatedDbHandle | undefined

  afterEach(async () => {
    await dbHandle?.dispose()
    dbHandle = undefined
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('refuses a request whose grant was never memoized (no auth middleware in front of it)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-membership-admit-'))
    dbHandle = await createIsolatedDb({ dataDir: dir })
    const members = createMemberProfileStore(dbHandle.db)
    // A gating member, so the refusal is the missing grant's and not the
    // workspace having nobody in it.
    const profile = await members.ensureProfile({
      binding: passkeyBinding('https://example.test', 'gating-member-cred'),
      displayName: 'Gating Member',
    })
    await members.addMember('ws1', profile.id)

    const admit = membershipAdmit(members)
    // No `createDaemonAuthMiddleware` mounted ahead of this route, so
    // `grantMemo` was never populated for this request — exactly the
    // "composition that omits the middleware" case `WorkspaceAdmit`'s doc
    // comment names as the fail-closed path.
    const app = new Hono()
    app.get('/probe', async (c) => c.json({ decision: await admit(c, 'ws1') }))

    const res = await app.request('/probe')
    const body = (await res.json()) as { decision: string }
    expect(body.decision).toBe('requires_person_session')
    expect(body.decision).not.toBe('admitted')
  })

  it('hands the grant the middleware resolved to a handler that decides membership itself', async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-membership-remembered-'))
    dbHandle = await createIsolatedDb({ dataDir: dir })
    const members = createMemberProfileStore(dbHandle.db)
    const person = passkeyBinding('https://example.test', 'member-cred')
    const profile = await members.ensureProfile({ binding: person, displayName: 'Member' })
    await members.addMember('ws1', profile.id)

    const grant: ResolvedGrant = { kind: 'signed-in', scopes: ['workspace:read'], person }
    const resolver: CredentialResolver = { resolve: async () => grant }
    const admit = membershipAdmit(members)
    const app = new Hono()
    app.use('/api/*', createDaemonAuthMiddleware(resolver))
    app.get('/api/workspaces/ws1', async (c) => c.json({ decision: await admit(c, 'ws1') }))

    const res = await app.request('/api/workspaces/ws1')

    // Were the grant not remembered, `admit` would find none and answer
    // `requires_person_session`; only the middleware's own grant names a member.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ decision: 'admitted' })
  })
})
