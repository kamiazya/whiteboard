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
  reopenOriginTrustResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import {
  pairingTokenResponseSchema,
  sessionAssertChallengeResponseSchema,
  sessionAssertResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import { apiErrorReason } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAssertion,
  registrationFor,
  WEBAUTHN_FLAG_BE,
  WEBAUTHN_FLAG_UP,
  WEBAUTHN_FLAG_UV,
} from '../../shared/test-utils/webauthn-fixtures.js'
import { createCredentialResolver } from '../security/credential-resolver.js'
import { createDaemonIdentity } from '../security/daemon-identity.js'
import { mintMacaroon } from '../security/macaroon.js'
import { createMemberProfileStore } from '../security/member-profile-store.js'
import { createPairingGrantStore } from '../security/pairing-grant-store.js'
import { createPairingCodeStore, createPairingTokenStore } from '../security/pairing-session.js'
import { createWebAuthnCredentialStore } from '../security/webauthn-credential-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from '../store/db/test-helpers.js'
import { tenantRoot } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { createDaemonAuthMiddleware } from './auth.js'
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
  const grants = createPairingGrantStore(tenantRoot(dir, SELF_HOST_TENANT_ID))
  const codes = createPairingCodeStore()
  const tokens = createPairingTokenStore()
  const identity = createDaemonIdentity({ dataDir: dir })
  const credentials = createWebAuthnCredentialStore(tenantRoot(dir, SELF_HOST_TENANT_ID))
  const members = createMemberProfileStore(dbHandle.db)
  const workspaceExists = async (id: string) => known.includes(id)

  const app = createPairingRouter({ grants, codes, tokens, credentials, identity, members })
  app.route('/', createMembershipRouter({ members, tokens, credentials, workspaceExists }))

  return { app, grants, tokens, credentials, members }
}

const DAEMON_TOKEN = 'the-daemon-token'
const MACAROON_ROOT_KEY = new Uint8Array(32).fill(7)

/**
 * `makeApp` builds the router directly, bypassing `createApp`'s `/api/*`
 * `createDaemonAuthMiddleware` mount entirely (`app.ts`'s local-daemon
 * branch) — a real client never reaches these routes that way. This wraps
 * the same real middleware `app.ts` mounts (mirroring `auth.macaroon.test.ts`'s
 * pattern) around the membership router, so the auth/scope enforcement below
 * exercises the actual gate rather than only what is behind it.
 */
async function makeAuthedApp(known: readonly string[] = [WS]) {
  const fixture = await makeApp(known)
  const authed = new Hono()
  authed.use(
    '/api/*',
    createDaemonAuthMiddleware(
      createCredentialResolver({ daemonToken: DAEMON_TOKEN, macaroonRootKey: MACAROON_ROOT_KEY }),
    ),
  )
  authed.route('/', fixture.app)
  return { ...fixture, app: authed }
}

afterEach(async () => {
  await dbHandle?.dispose()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function get(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  path: string,
  headers: Record<string, string> = {},
) {
  return app.request(path, { headers })
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

async function del(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  path: string,
  headers: Record<string, string> = {},
) {
  return app.request(path, { method: 'DELETE', headers })
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

  // Same refusal as POST/DELETE (which already check workspaceExists) —
  // otherwise an unregistered workspace id reads as "real, but empty" rather
  // than "never heard of it".
  it('refuses an unknown workspace, matching POST/DELETE', async () => {
    const { app } = await makeApp([])
    const res = await get(app, `/api/workspaces/${WS}/members`)
    expect(res.status).toBe(404)
    const body = membershipRefusalSchema.parse(await res.json())
    expect(body.error).toBe('unknown_workspace')
  })

  // workspaceExists (serverDeps.workspaceDocuments.exists in production)
  // throws a ValidationError for a workspaceId shaped like path traversal —
  // the route must turn that into a 400, not let it fall through to Hono's
  // plain-text default handler.
  it('answers 400 for a workspaceId validateWorkspaceId rejects', async () => {
    const { app } = await makeApp()
    const res = await get(app, '/api/workspaces/not*safe/members')
    expect(res.status).toBe(400)
    const body = membershipRefusalSchema.parse(await res.json())
    expect(body.error).toBe('invalid_workspace_id')
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

  // post() JSON.stringifies its body, so it can never produce bytes that
  // fail c.req.json() itself — exercise that branch with a raw request.
  it('rejects a body that does not parse as JSON at all', async () => {
    const fixture = await makeApp()
    const res = await fixture.app.request(`/api/workspaces/${WS}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'invalid_body', message: expect.any(String) })
    // The point of the code+reason split: a client reads the reason through
    // the one shared reader, not by recognising a sentence in the code slot.
    expect(apiErrorReason(body)).toContain('not valid JSON')
  })

  // addMemberRequestSchema only checks origin is a non-empty string, not that
  // it parses as a URL — this is the `new URL(...)` catch branch's own case.
  it('rejects an origin that does not parse as a URL', async () => {
    const fixture = await makeApp()
    const res = await post(fixture.app, `/api/workspaces/${WS}/members`, {
      credentialId: 'x',
      origin: 'not-a-url',
      displayName: 'Ada Lovelace',
    } satisfies AddMemberRequest)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'invalid_origin', message: expect.any(String) })
    expect(apiErrorReason(body)).toContain('http(s) URL')
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
  // Parity with GET/POST: an unregistered workspace answers unknown_workspace,
  // not unknown_profile — the same profileId lookup would otherwise find
  // nothing and misreport "no such member" for a workspace never registered.
  it('refuses an unknown workspace, matching GET/POST', async () => {
    const { app } = await makeApp([])
    const res = await del(app, `/api/workspaces/${WS}/members/some-profile`)
    expect(res.status).toBe(404)
    const body = membershipRefusalSchema.parse(await res.json())
    expect(body.error).toBe('unknown_workspace')
  })

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

// route-scope-registry.test.ts only proves these three paths are CLASSIFIED
// as runtime:admin; it never runs a request through the daemon's real auth
// middleware. This does, through the same createDaemonAuthMiddleware app.ts
// mounts in front of every /api/* route.
describe('membership routes enforce the runtime:admin scope through the real auth middleware', () => {
  it('refuses every verb with no Authorization header once a daemon token is configured', async () => {
    const { app } = await makeAuthedApp()

    expect((await get(app, `/api/workspaces/${WS}/members`)).status).toBe(401)
    expect(
      (
        await post(app, `/api/workspaces/${WS}/members`, {
          credentialId: 'x',
          origin: HOSTED,
          displayName: 'Ada Lovelace',
        } satisfies AddMemberRequest)
      ).status,
    ).toBe(401)
    expect((await del(app, `/api/workspaces/${WS}/members/some-profile`)).status).toBe(401)
  })

  it('refuses a macaroon caveated below runtime:admin', async () => {
    const { app } = await makeAuthedApp()
    const underScoped = await mintMacaroon({
      rootKey: MACAROON_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    const res = await get(app, `/api/workspaces/${WS}/members`, {
      Authorization: `Bearer ${underScoped}`,
    })
    expect(res.status).toBe(401)
  })

  it('admits a macaroon caveated with runtime:admin, through the real middleware', async () => {
    const { app } = await makeAuthedApp()
    const scoped = await mintMacaroon({
      rootKey: MACAROON_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['runtime:admin'] }],
    })

    const res = await get(app, `/api/workspaces/${WS}/members`, {
      Authorization: `Bearer ${scoped}`,
    })
    expect(res.status).toBe(200)
    expect(listMembersResponseSchema.parse(await res.json())).toEqual({ members: [] })
  })

  it('the daemon token itself authorizes POST through the real middleware', async () => {
    const fixture = await makeAuthedApp()
    const pin = pinPasskey(fixture)

    const res = await post(
      fixture.app,
      `/api/workspaces/${WS}/members`,
      { credentialId: pin.credentialId, origin: pin.origin, displayName: 'Ada Lovelace' },
      { Authorization: `Bearer ${DAEMON_TOKEN}` },
    )
    expect(res.status).toBe(201)
  })
})

describe('reopening a member-gated workspace to origin trust', () => {
  it('answers wasMembersOnly:false for a workspace no member ever joined', async () => {
    const fixture = await makeApp()

    const res = await del(fixture.app, `/api/workspaces/${WS}/members-only`)

    // Not a 404: the workspace exists and the request is well formed, there
    // was simply nothing to clear. An operator asking twice learns which.
    expect(res.status).toBe(200)
    expect(reopenOriginTrustResponseSchema.parse(await res.json())).toEqual({
      wasMembersOnly: false,
    })
  })

  it('clears the gate and says it was closed', async () => {
    const fixture = await makeApp()
    const pin = pinPasskey(fixture)
    const added = await post(fixture.app, `/api/workspaces/${WS}/members`, {
      credentialId: pin.credentialId,
      origin: pin.origin,
      displayName: 'Ada Lovelace',
    } satisfies AddMemberRequest)
    expect(added.status).toBe(201)
    expect(await fixture.members.membersOnly(WS)).toBe(true)

    const res = await del(fixture.app, `/api/workspaces/${WS}/members-only`)

    expect(res.status).toBe(200)
    expect(reopenOriginTrustResponseSchema.parse(await res.json())).toEqual({
      wasMembersOnly: true,
    })
    expect(await fixture.members.membersOnly(WS)).toBe(false)
  })

  it('leaves the members in place, so the list still answers them', async () => {
    const fixture = await makeApp()
    const pin = pinPasskey(fixture)
    await post(fixture.app, `/api/workspaces/${WS}/members`, {
      credentialId: pin.credentialId,
      origin: pin.origin,
      displayName: 'Ada Lovelace',
    } satisfies AddMemberRequest)

    await del(fixture.app, `/api/workspaces/${WS}/members-only`)

    // Reopening widens who may read; it does not remove who already could.
    const list = await get(fixture.app, `/api/workspaces/${WS}/members`)
    expect(listMembersResponseSchema.parse(await list.json()).members).toHaveLength(1)
  })

  it('refuses an unknown workspace rather than reporting a clear', async () => {
    const fixture = await makeApp()

    const res = await del(fixture.app, '/api/workspaces/01JNOSUCHWORKSPACE000000000/members-only')

    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('unknown_workspace')
  })

  it('refuses a malformed workspace id with a 400', async () => {
    const fixture = await makeApp()

    const res = await del(fixture.app, '/api/workspaces/..%2Fetc/members-only')

    expect(res.status).toBe(400)
  })
})

// The bar here is judged by the grant's KIND, not its scopes, which is the
// one thing about this route worth proving through the real middleware: a
// pairing grant carries EVERY scope (`credential-resolver.ts`), so a
// scope-based bar would not separate an operator from a paired browser at
// all. `daemon-token-only` does.
describe('the reopen route is barred to the daemon token, by kind rather than scope', () => {
  it('refuses a macaroon that HAS runtime:admin', async () => {
    const { app } = await makeAuthedApp()
    const scoped = await mintMacaroon({
      rootKey: MACAROON_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['runtime:admin'] }],
    })

    // The same token is ADMITTED on the member routes beside it (see the
    // suite above), so this is the bar differing rather than the scope
    // being absent — which is what makes it evidence.
    const res = await del(app, `/api/workspaces/${WS}/members-only`, {
      Authorization: `Bearer ${scoped}`,
    })
    expect(res.status).toBe(401)
  })

  it('admits the daemon token itself', async () => {
    const { app } = await makeAuthedApp()

    const res = await del(app, `/api/workspaces/${WS}/members-only`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    expect(res.status).toBe(200)
  })

  it('refuses no Authorization header at all', async () => {
    const { app } = await makeAuthedApp()

    expect((await del(app, `/api/workspaces/${WS}/members-only`)).status).toBe(401)
  })
})
