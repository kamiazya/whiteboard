/**
 * GET/POST/DELETE /api/workspaces/:workspaceId/members (ADR-0041 S0-4): list,
 * add, and L1-remove a workspace member, with the synchronous session kill
 * (ADR-0042 decision 3).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AddMemberRequest,
  listMembersResponseSchema,
  memberProfileSummarySchema,
  membershipRefusalSchema,
  removeMemberResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import {
  pairingTokenResponseSchema,
  sessionAssertChallengeResponseSchema,
  sessionAssertResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAssertion,
  registrationFor,
  WEBAUTHN_FLAG_BE,
  WEBAUTHN_FLAG_UP,
  WEBAUTHN_FLAG_UV,
} from '../../shared/test-utils/webauthn-fixtures.js'
import { createDaemonIdentity } from '../security/daemon-identity.js'
import { createMemberProfileStore } from '../security/member-profile-store.js'
import { createPairingGrantStore } from '../security/pairing-grant-store.js'
import { createPairingCodeStore, createPairingTokenStore } from '../security/pairing-session.js'
import { createWebAuthnCredentialStore } from '../security/webauthn-credential-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from '../store/db/test-helpers.js'
import { createMembershipRouter } from './membership.js'
import { createPairingRouter } from './pairing.js'

const WS = 'ws-1'
const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'
const HOST = new URL(HOSTED).hostname
const FLAGS = WEBAUTHN_FLAG_UP | WEBAUTHN_FLAG_UV | WEBAUTHN_FLAG_BE

let dir: string
let dbHandle: IsolatedDbHandle

async function makeApp(known: readonly string[] = [WS]) {
  dir = mkdtempSync(join(tmpdir(), 'membership-routes-'))
  dbHandle = await createIsolatedDb({ dataDir: dir })
  const grants = createPairingGrantStore(dir)
  const codes = createPairingCodeStore()
  const tokens = createPairingTokenStore()
  const identity = createDaemonIdentity({ dataDir: dir })
  const credentials = createWebAuthnCredentialStore(dir)
  const members = createMemberProfileStore(dbHandle.db)
  const workspaceExists = async (id: string) => known.includes(id)

  const app = createPairingRouter({ grants, codes, tokens, credentials, identity, members })
  app.route('/', createMembershipRouter({ members, tokens, credentials, workspaceExists }))

  return { app, grants, tokens, credentials, members }
}

afterEach(async () => {
  await dbHandle?.dispose()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function get(app: Awaited<ReturnType<typeof makeApp>>['app'], path: string) {
  return app.request(path)
}

async function post(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function del(app: Awaited<ReturnType<typeof makeApp>>['app'], path: string) {
  return app.request(path, { method: 'DELETE' })
}

/** Pins a passkey for HOSTED (keeping the private key) without pairing an
 *  origin grant — an administrator adding a member does not need a live
 *  paired session for that origin, only a pin the daemon already trusts. */
function pinPasskey(fixture: Awaited<ReturnType<typeof makeApp>>, origin = HOSTED) {
  const reg = registrationFor(new URL(origin).hostname)
  const { keypair, ...registration } = reg
  fixture.credentials.register({
    origin,
    rpId: new URL(origin).hostname,
    credentialId: registration.credentialId,
    publicKeyJwk: registration.publicKeyJwk,
    backupEligible: registration.backupEligible,
    signCount: 0,
  })
  return { credentialId: registration.credentialId, keypair, origin }
}

describe('GET /api/workspaces/:workspaceId/members', () => {
  it('answers an empty list for a workspace with no members', async () => {
    const { app } = await makeApp()
    const res = await get(app, `/api/workspaces/${WS}/members`)
    expect(res.status).toBe(200)
    expect(listMembersResponseSchema.parse(await res.json())).toEqual({ members: [] })
  })
})

describe('POST /api/workspaces/:workspaceId/members', () => {
  it('refuses an unknown workspace', async () => {
    const fixture = await makeApp([])
    const pin = pinPasskey(fixture)
    const res = await post(fixture.app, `/api/workspaces/${WS}/members`, {
      credentialId: pin.credentialId,
      origin: pin.origin,
      displayName: 'Ada Lovelace',
    } satisfies AddMemberRequest)
    expect(res.status).toBe(404)
    const body = membershipRefusalSchema.parse(await res.json())
    expect(body.error).toBe('unknown_workspace')
  })

  it('refuses a credential nothing has pinned', async () => {
    const fixture = await makeApp()
    const res = await post(fixture.app, `/api/workspaces/${WS}/members`, {
      credentialId: 'nobody-pinned-this',
      origin: HOSTED,
      displayName: 'Ada Lovelace',
    } satisfies AddMemberRequest)
    expect(res.status).toBe(404)
    const body = membershipRefusalSchema.parse(await res.json())
    expect(body.error).toBe('unknown_credential')
  })

  it('rejects a malformed request body', async () => {
    const fixture = await makeApp()
    const res = await post(fixture.app, `/api/workspaces/${WS}/members`, {
      credentialId: 'x',
    })
    expect(res.status).toBe(400)
  })

  it('adds a pinned passkey as a member and the list reflects it', async () => {
    const fixture = await makeApp()
    const pin = pinPasskey(fixture)
    const res = await post(fixture.app, `/api/workspaces/${WS}/members`, {
      credentialId: pin.credentialId,
      origin: pin.origin,
      displayName: 'Ada Lovelace',
    } satisfies AddMemberRequest)
    expect(res.status).toBe(201)
    const summary = memberProfileSummarySchema.parse(await res.json())
    expect(summary.displayName).toBe('Ada Lovelace')
    expect(summary.credentials).toEqual([{ credentialId: pin.credentialId, origin: pin.origin }])
    expect(new Date(summary.createdAt).toISOString()).toBe(summary.createdAt)

    const listRes = await get(fixture.app, `/api/workspaces/${WS}/members`)
    const list = listMembersResponseSchema.parse(await listRes.json())
    expect(list.members).toEqual([summary])
  })

  it('is idempotent: adding the same credential twice keeps one profile and ignores the later name', async () => {
    const fixture = await makeApp()
    const pin = pinPasskey(fixture)
    const first = memberProfileSummarySchema.parse(
      await (
        await post(fixture.app, `/api/workspaces/${WS}/members`, {
          credentialId: pin.credentialId,
          origin: pin.origin,
          displayName: 'Ada Lovelace',
        } satisfies AddMemberRequest)
      ).json(),
    )
    const second = memberProfileSummarySchema.parse(
      await (
        await post(fixture.app, `/api/workspaces/${WS}/members`, {
          credentialId: pin.credentialId,
          origin: pin.origin,
          displayName: 'Someone Else',
        } satisfies AddMemberRequest)
      ).json(),
    )
    expect(second.profileId).toBe(first.profileId)
    expect(second.displayName).toBe('Ada Lovelace')

    const listRes = await get(fixture.app, `/api/workspaces/${WS}/members`)
    const list = listMembersResponseSchema.parse(await listRes.json())
    expect(list.members).toHaveLength(1)
  })
})

describe('DELETE /api/workspaces/:workspaceId/members/:profileId', () => {
  it('refuses an unknown profileId', async () => {
    const fixture = await makeApp()
    const res = await del(fixture.app, `/api/workspaces/${WS}/members/no-such-profile`)
    expect(res.status).toBe(404)
    const body = membershipRefusalSchema.parse(await res.json())
    expect(body.error).toBe('unknown_profile')
  })

  it('removing the same member twice answers unknown_profile the second time', async () => {
    const fixture = await makeApp()
    const pin = pinPasskey(fixture)
    const added = memberProfileSummarySchema.parse(
      await (
        await post(fixture.app, `/api/workspaces/${WS}/members`, {
          credentialId: pin.credentialId,
          origin: pin.origin,
          displayName: 'Ada Lovelace',
        } satisfies AddMemberRequest)
      ).json(),
    )
    const first = await del(fixture.app, `/api/workspaces/${WS}/members/${added.profileId}`)
    expect(first.status).toBe(200)
    const second = await del(fixture.app, `/api/workspaces/${WS}/members/${added.profileId}`)
    expect(second.status).toBe(404)
  })
})

describe('the full pairing chain: pin -> unbound assertion -> add member -> bound assertion -> L1 removal', () => {
  it('binds profileId only after admission, and removal synchronously kills the live session', async () => {
    const fixture = await makeApp()

    // Pair the origin and pin the passkey through the real pairing flow so a
    // session token exists to assert with.
    fixture.grants.addGrant(HOSTED)
    const reg = registrationFor(HOST)
    const { keypair, ...registration } = reg
    const pinRes = await post(fixture.app, '/api/pairing/credentials', registration, {
      Origin: HOSTED,
    })
    expect(pinRes.status).toBe(201)
    const credentialId = registration.credentialId

    const tokenRes = await post(
      fixture.app,
      '/api/pairing/token',
      { grantType: 'origin' },
      { Origin: HOSTED },
    )
    const { token } = pairingTokenResponseSchema.parse(await tokenRes.json())

    let signCount = 0
    async function assertSession() {
      signCount += 1
      const challengeRes = await fixture.app.request('/api/pairing/session-assert/challenge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Origin: HOSTED },
      })
      const { challenge } = sessionAssertChallengeResponseSchema.parse(await challengeRes.json())
      const assertion = buildAssertion({
        privateKey: keypair.privateKey,
        rpId: HOST,
        origin: HOSTED,
        challenge: Buffer.from(challenge, 'base64url'),
        flags: FLAGS,
        signCount,
      })
      return post(
        fixture.app,
        '/api/pairing/session-assert',
        {
          credentialId,
          authenticatorData: assertion.authenticatorData.toString('base64url'),
          clientDataJSON: assertion.clientDataJSON.toString('base64url'),
          signature: assertion.signature.toString('base64url'),
        },
        { Authorization: `Bearer ${token}`, Origin: HOSTED },
      )
    }

    // Before admission: the pin has no MemberProfile yet.
    const beforeRes = await assertSession()
    expect(beforeRes.status).toBe(200)
    const before = sessionAssertResponseSchema.parse(await beforeRes.json())
    expect(before.profileId).toBeNull()

    // Admit the passkey as a member.
    const addRes = await post(fixture.app, `/api/workspaces/${WS}/members`, {
      credentialId,
      origin: HOSTED,
      displayName: 'Ada Lovelace',
    } satisfies AddMemberRequest)
    expect(addRes.status).toBe(201)
    const member = memberProfileSummarySchema.parse(await addRes.json())

    // After admission: a fresh assertion resolves the member's profileId.
    const afterRes = await assertSession()
    expect(afterRes.status).toBe(200)
    const after = sessionAssertResponseSchema.parse(await afterRes.json())
    expect(after.profileId).toBe(member.profileId)
    expect(fixture.tokens.validate(token, HOSTED)).toBe(true)

    // A second, never-bound token for the same origin — must survive L1
    // removal, since revokeBoundTo only kills tokens bound to the removed
    // credentials.
    const otherTokenRes = await post(
      fixture.app,
      '/api/pairing/token',
      { grantType: 'origin' },
      { Origin: HOSTED },
    )
    const { token: unboundToken } = pairingTokenResponseSchema.parse(await otherTokenRes.json())

    // L1-remove the member: the bound session dies synchronously.
    const delRes = await del(fixture.app, `/api/workspaces/${WS}/members/${member.profileId}`)
    expect(delRes.status).toBe(200)
    const removed = removeMemberResponseSchema.parse(await delRes.json())
    expect(removed).toEqual({ removed: true, sessionsEnded: 1 })

    expect(fixture.tokens.validate(token, HOSTED)).toBe(false)
    expect(fixture.tokens.validate(unboundToken, HOSTED)).toBe(true)
    expect(await fixture.members.isWorkspaceMember(WS, member.profileId)).toBe('not-a-member')
    // L1 is not L2: the pin itself survives removal.
    expect(fixture.credentials.find(HOSTED, credentialId)).not.toBeNull()
  })
})
