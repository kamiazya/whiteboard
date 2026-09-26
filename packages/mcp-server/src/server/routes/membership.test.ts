/**
 * The local daemon's members (ADR-0041 S0-4, ADR-0049 decision 5): a pinned
 * passkey is added through POST /api/workspaces/:workspaceId/members, and the
 * workspace's people are then listed, re-roled and L1-removed through the
 * people API server mode shares, with the synchronous session kill
 * (ADR-0042 decision 3) as the local keeper's own step.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AddMemberRequest,
  memberProfileSummarySchema,
  membershipRefusalSchema,
  reopenOriginTrustResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import {
  pairingTokenResponseSchema,
  sessionAssertChallengeResponseSchema,
  sessionAssertResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import {
  removeWorkspacePersonResponseSchema,
  workspacePeopleResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
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
import { ALL_AUTH_SCOPES } from '../security/auth-strategy.js'
import { createCredentialResolver } from '../security/credential-resolver.js'
import { createDaemonIdentity } from '../security/daemon-identity.js'
import { mintMacaroon } from '../security/macaroon.js'
import { createMemberProfileStore } from '../security/member-profile-store.js'
import { rememberGrant } from '../security/membership-gate.js'
import { createPairingGrantStore } from '../security/pairing-grant-store.js'
import { createPairingCodeStore, createPairingTokenStore } from '../security/pairing-session.js'
import { localDaemonPeopleKeeper } from '../security/people-keepers.js'
import { createWebAuthnCredentialStore } from '../security/webauthn-credential-store.js'
import { createWorkspaceRoles } from '../security/workspace-roles.js'
import { createIsolatedDb, type IsolatedDbHandle } from '../store/db/test-helpers.js'
import { tenantRoot } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { createDaemonAuthMiddleware } from './auth.js'
import { createMembershipRouter } from './membership.js'
import { createPairingRouter } from './pairing.js'
import { createWorkspacePeopleRouter } from './workspace-people.js'

const WS = 'ws-1'
const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'
const HOST = new URL(HOSTED).hostname
const FLAGS = WEBAUTHN_FLAG_UP | WEBAUTHN_FLAG_UV | WEBAUTHN_FLAG_BE

let dir: string
let dbHandle: IsolatedDbHandle

// The grant the daemon's own middleware resolves for the daemon token, which
// `makeAuthedApp` below runs for real; here the routers are mounted bare, as
// the machine's owner would reach them.
function asTheMachineOwner(app: Hono) {
  app.use('/api/workspaces/*', async (c, next) => {
    if (c.req.header('Authorization') === undefined) {
      rememberGrant(c, { kind: 'daemon-token', scopes: ALL_AUTH_SCOPES })
    }
    await next()
  })
}

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
  asTheMachineOwner(app)
  app.route('/', createMembershipRouter({ members, credentials, workspaceExists }))
  const roles = createWorkspaceRoles(dbHandle.db, { ownedByTheMachine: true })
  const keeper = localDaemonPeopleKeeper({ members, tokens })
  app.route('/', createWorkspacePeopleRouter({ members, roles, keeper }))

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

describe('GET /api/workspaces/:workspace/people on the local daemon', () => {
  it('answers an empty list, and that the machine owner may change it', async () => {
    const { app } = await makeApp()
    const res = await get(app, `/api/workspaces/${WS}/people`)
    expect(res.status).toBe(200)
    expect(workspacePeopleResponseSchema.parse(await res.json())).toEqual({
      people: [],
      canManage: true,
    })
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

    const listRes = await get(fixture.app, `/api/workspaces/${WS}/people`)
    const list = workspacePeopleResponseSchema.parse(await listRes.json())
    expect(list.people).toEqual([
      { userId: summary.profileId, displayName: 'Ada Lovelace', role: 'owner', deactivated: false },
    ])
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

    const listRes = await get(fixture.app, `/api/workspaces/${WS}/people`)
    const list = workspacePeopleResponseSchema.parse(await listRes.json())
    expect(list.people).toHaveLength(1)
  })
})

describe('DELETE /api/workspaces/:workspace/people/:userId on the local daemon', () => {
  it('refuses a person who is not a member', async () => {
    const fixture = await makeApp()
    const res = await del(fixture.app, `/api/workspaces/${WS}/people/no-such-profile`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('not_a_member')
  })

  // The machine's owner owns every workspace, so its last recorded member
  // may leave — unlike server mode, where the last owner stays.
  it('removes the last member, and answers not_a_member the second time', async () => {
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
    const first = await del(fixture.app, `/api/workspaces/${WS}/people/${added.profileId}`)
    expect(first.status).toBe(200)
    const second = await del(fixture.app, `/api/workspaces/${WS}/people/${added.profileId}`)
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
    const delRes = await del(fixture.app, `/api/workspaces/${WS}/people/${member.profileId}`)
    expect(delRes.status).toBe(200)
    expect(removeWorkspacePersonResponseSchema.parse(await delRes.json())).toEqual({
      removed: true,
    })

    expect(fixture.tokens.validate(token, HOSTED)).toBe(false)
    expect(fixture.tokens.validate(unboundToken, HOSTED)).toBe(true)
    expect(await fixture.members.isWorkspaceMember(WS, member.profileId)).toBe('not-a-member')
    // L1 is not L2: the pin itself survives removal.
    expect(fixture.credentials.find(HOSTED, credentialId)).not.toBeNull()
  })
})

// route-scope-registry.test.ts only CLASSIFIES these paths; this runs requests
// through the same createDaemonAuthMiddleware app.ts mounts in front of every
// /api/* route. Adding a passkey is runtime:admin by its route; changing a
// workspace's people asks the local keeper, which wants runtime:admin too —
// the bar these routes had before they were shared with server mode.
describe('the local members surface through the real auth middleware', () => {
  const macaroon = (scopes: string[]) =>
    mintMacaroon({
      rootKey: MACAROON_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: scopes as never }],
    })

  it('refuses every verb with no Authorization header once a daemon token is configured', async () => {
    const { app } = await makeAuthedApp()

    expect((await get(app, `/api/workspaces/${WS}/people`)).status).toBe(401)
    expect(
      (
        await post(app, `/api/workspaces/${WS}/members`, {
          credentialId: 'x',
          origin: HOSTED,
          displayName: 'Ada Lovelace',
        } satisfies AddMemberRequest)
      ).status,
    ).toBe(401)
    expect((await del(app, `/api/workspaces/${WS}/people/some-profile`)).status).toBe(401)
  })

  it('refuses adding a passkey to a macaroon caveated below runtime:admin', async () => {
    const { app } = await makeAuthedApp()
    const res = await post(
      app,
      `/api/workspaces/${WS}/members`,
      { credentialId: 'x', origin: HOSTED, displayName: 'Ada Lovelace' },
      { Authorization: `Bearer ${await macaroon(['workspace:read', 'workspace:write'])}` },
    )
    expect(res.status).toBe(401)
  })

  it('lets a credential without runtime:admin read the people and change none of them', async () => {
    const fixture = await makeAuthedApp()
    const pin = pinPasskey(fixture)
    const added = memberProfileSummarySchema.parse(
      await (
        await post(
          fixture.app,
          `/api/workspaces/${WS}/members`,
          { credentialId: pin.credentialId, origin: pin.origin, displayName: 'Ada Lovelace' },
          { Authorization: `Bearer ${DAEMON_TOKEN}` },
        )
      ).json(),
    )
    const reader = {
      Authorization: `Bearer ${await macaroon(['workspace:read', 'workspace:write'])}`,
    }
    const listed = await get(fixture.app, `/api/workspaces/${WS}/people`, reader)
    expect(workspacePeopleResponseSchema.parse(await listed.json()).canManage).toBe(false)
    const removed = await del(
      fixture.app,
      `/api/workspaces/${WS}/people/${added.profileId}`,
      reader,
    )
    expect(removed.status).toBe(403)
    expect(((await removed.json()) as { error: string }).error).toBe('not_an_owner')
  })

  it('lets a credential with runtime:admin change them', async () => {
    const { app } = await makeAuthedApp()
    const admin = {
      Authorization: `Bearer ${await macaroon(['runtime:admin', 'workspace:read', 'workspace:write'])}`,
    }
    const res = await get(app, `/api/workspaces/${WS}/people`, admin)
    expect(workspacePeopleResponseSchema.parse(await res.json())).toEqual({
      people: [],
      canManage: true,
    })
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
    const list = await get(fixture.app, `/api/workspaces/${WS}/people`)
    expect(workspacePeopleResponseSchema.parse(await list.json()).people).toHaveLength(1)
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
