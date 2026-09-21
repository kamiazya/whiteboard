/**
 * S8 slice 2: the membership gate wired onto every route the
 * route-scope-registry marks GATED, plus the two surfaces that decide
 * membership themselves rather than through a route rule — the SSE
 * transport (per doc key) and the workspace list (filtered, not refused).
 * Wired through the real `createDaemonAuthMiddleware` chain, the same
 * pattern `replica-key.test.ts` uses, so the registry rule is exercised
 * rather than only pinned in isolation.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pairingTokenResponseSchema,
  sessionAssertChallengeResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import {
  buildAssertion,
  registrationFor,
  WEBAUTHN_FLAG_BE,
  WEBAUTHN_FLAG_UP,
  WEBAUTHN_FLAG_UV,
} from '../../shared/test-utils/webauthn-fixtures.js'
import { captureLogsForTests } from '../log.js'
import { createCredentialResolver } from '../security/credential-resolver.js'
import { createDaemonIdentity } from '../security/daemon-identity.js'
import { createMemberProfileStore } from '../security/member-profile-store.js'
import { createPairingGrantStore } from '../security/pairing-grant-store.js'
import { createPairingCodeStore, createPairingTokenStore } from '../security/pairing-session.js'
import { createWebAuthnCredentialStore } from '../security/webauthn-credential-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from '../store/db/test-helpers.js'
import { createDaemonAuthMiddleware, membershipAdmit } from './auth.js'
import { createWorkspacesRouter } from './document/workspaces.js'
import { createMembershipRouter } from './membership.js'
import { createPairingRouter } from './pairing.js'
import { createSyncSseRouter } from './sync-sse.js'

const WS = 'ws1'
const MEMBER_LESS_WS = 'ws2'
const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'
const HOST = new URL(HOSTED).hostname
const FLAGS = WEBAUTHN_FLAG_UP | WEBAUTHN_FLAG_UV | WEBAUTHN_FLAG_BE
const DAEMON_TOKEN = 'the-daemon-token'

let dir: string
let dbHandle: IsolatedDbHandle

async function makeApp() {
  dir = mkdtempSync(join(tmpdir(), 'auth-membership-gate-'))
  dbHandle = await createIsolatedDb({ dataDir: dir })
  const grants = createPairingGrantStore(dir)
  const codes = createPairingCodeStore()
  const tokens = createPairingTokenStore()
  const identity = createDaemonIdentity({ dataDir: dir })
  const credentials = createWebAuthnCredentialStore(dir)
  const members = createMemberProfileStore(dbHandle.db)
  const serverDeps = resolveServerDeps(createContainer())
  await serverDeps.documentIndex.createWorkspace({ workspaceId: WS })

  const credentialResolver = createCredentialResolver({
    daemonToken: DAEMON_TOKEN,
    pairingTokens: tokens,
  })

  const admit = membershipAdmit(members)
  const pairing = createPairingRouter({ grants, codes, tokens, credentials, identity, members })
  const membership = createMembershipRouter({
    members,
    tokens,
    credentials,
    workspaceExists: (id) => Promise.resolve(id === WS || id === MEMBER_LESS_WS),
  })
  const workspaces = createWorkspacesRouter({ serverDeps, admit })
  const sync = createSyncSseRouter({ admit })

  const authed = new Hono()
  authed.use('/api/*', createDaemonAuthMiddleware(credentialResolver, { members }))
  authed.route('/', pairing)
  authed.route('/', membership)
  authed.route('/', workspaces)
  authed.route('/', sync)
  // Stub for the GATED probe paths this fixture has no real router for
  // (document/version/checkpoint/file surfaces): the gate runs in
  // middleware, before any handler, so a stub is enough to observe the
  // gate's own decision without standing up every real router.
  authed.all('*', (c) => c.json({ ok: true }))

  return { app: authed, grants, tokens, credentials, members, serverDeps }
}

afterEach(async () => {
  await dbHandle?.dispose()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

type Fixture = Awaited<ReturnType<typeof makeApp>>

/** An unbound pairing session token — the shortest way to a `pairing` grant
 *  with no passkey binding, so `workspaceAccess` answers `admitted` (a
 *  member-less workspace) or `requires_person_session` (a gated one). */
async function mintUnboundToken(fixture: Fixture): Promise<string> {
  fixture.grants.addGrant(HOSTED)
  const res = await fixture.app.request('/api/pairing/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: HOSTED },
    body: JSON.stringify({ grantType: 'origin' }),
  })
  const { token } = pairingTokenResponseSchema.parse(await res.json())
  return token
}

async function bindSession(fixture: Fixture) {
  fixture.grants.addGrant(HOSTED)
  const reg = registrationFor(HOST)
  const { keypair, ...registration } = reg
  const credentialId = registration.credentialId

  const tokenRes = await fixture.app.request('/api/pairing/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: HOSTED },
    body: JSON.stringify({ grantType: 'origin' }),
  })
  const { token } = pairingTokenResponseSchema.parse(await tokenRes.json())

  const pinRes = await fixture.app.request('/api/pairing/credentials', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: HOSTED,
    },
    body: JSON.stringify(registration),
  })
  expect(pinRes.status).toBe(201)

  let signCount = 0
  async function assertSession(assertToken: string) {
    signCount += 1
    const challengeRes = await fixture.app.request('/api/pairing/session-assert/challenge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${assertToken}`, Origin: HOSTED },
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
    return fixture.app.request('/api/pairing/session-assert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assertToken}`,
        Origin: HOSTED,
      },
      body: JSON.stringify({
        credentialId,
        authenticatorData: assertion.authenticatorData.toString('base64url'),
        clientDataJSON: assertion.clientDataJSON.toString('base64url'),
        signature: assertion.signature.toString('base64url'),
      }),
    })
  }

  const bound = await assertSession(token)
  expect(bound.status).toBe(200)
  return { token, credentialId, origin: HOSTED, assertSession }
}

/** Seeds a second, unrelated member directly through the store so the
 *  workspace stays member-GATED for a test that is not about that member —
 *  without this, a workspace with zero members admits everyone (S8). */
async function addGatingMember(fixture: Fixture, workspaceId = WS) {
  const profile = await fixture.members.ensureProfile({
    origin: HOSTED,
    credentialId: 'gating-member-cred',
    displayName: 'Gating Member',
  })
  await fixture.members.addMember(workspaceId, profile.id)
  return profile
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Origin: HOSTED }
}

const GATED_CLAIMS: Record<string, readonly [string, string]> = {
  'document file': ['GET', `/api/w/${WS}/document/a/b/file/f1`],
  'workspace-document/promote': ['POST', `/api/w/${WS}/workspace-document/promote`],
  'workspace-document sync': ['POST', `/api/w/${WS}/workspace-document/update`],
  'document update/export': ['POST', `/api/w/${WS}/document/d1/update`],
  'document (rest)': ['GET', `/api/w/${WS}/document/d1`],
  'document versions/compact': ['GET', `/api/workspaces/${WS}/documents/d1/versions`],
  'document branches': ['GET', `/api/workspaces/${WS}/documents/d1/branches`],
  'workspace checkpoints': ['POST', `/api/workspaces/${WS}/checkpoints`],
  'versions/prune-sandwiched': ['POST', `/api/workspaces/${WS}/versions/prune-sandwiched`],
  'files/purge-dangling': ['POST', `/api/workspaces/${WS}/files/purge-dangling`],
  'documents/optimize-all': ['POST', `/api/workspaces/${WS}/documents/optimize-all`],
  'workspaces (rest)': ['GET', `/api/workspaces/${WS}`],
}

describe.for(Object.entries(GATED_CLAIMS))('gated row %s', ([name, [method, path]]) => {
  it(`${name}: a bare pairing grant on a member-gated workspace is refused requires_person_session`, async () => {
    const fixture = await makeApp()
    await addGatingMember(fixture)
    const token = await mintUnboundToken(fixture)

    const res = await fixture.app.request(path, { method, headers: bearer(token) })
    expect(res.status, `${method} ${path}`).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'requires_person_session' })
  })

  it(`${name}: a bound non-member is refused not_a_member`, async () => {
    const fixture = await makeApp()
    await addGatingMember(fixture)
    const session = await bindSession(fixture)

    const res = await fixture.app.request(path, { method, headers: bearer(session.token) })
    expect(res.status, `${method} ${path}`).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'not_a_member' })
  })

  it(`${name}: a bound member passes`, async () => {
    const fixture = await makeApp()
    const session = await bindSession(fixture)
    const profile = await fixture.members.ensureProfile({
      origin: HOSTED,
      credentialId: session.credentialId,
      displayName: 'Ada',
    })
    await fixture.members.addMember(WS, profile.id)

    const res = await fixture.app.request(path, { method, headers: bearer(session.token) })
    expect(res.status, `${method} ${path}`).not.toBe(403)
  })

  it(`${name}: the daemon token bypasses membership`, async () => {
    const fixture = await makeApp()
    await addGatingMember(fixture)

    const res = await fixture.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    })
    expect(res.status, `${method} ${path}`).not.toBe(403)
  })

  it(`${name}: a bare pairing grant on a member-less workspace passes (origin trust)`, async () => {
    const fixture = await makeApp()
    const token = await mintUnboundToken(fixture)

    const swapped = path.replace(WS, MEMBER_LESS_WS)
    const res = await fixture.app.request(swapped, { method, headers: bearer(token) })
    expect(res.status, `${method} ${swapped}`).not.toBe(403)
  })
})

describe('the middleware logs a refusal with fields, and nothing on admission', () => {
  it('logs { workspaceId, rule, reason } fields-first on a refusal', async () => {
    const fixture = await makeApp()
    await addGatingMember(fixture)
    const token = await mintUnboundToken(fixture)
    const capture = captureLogsForTests('warning')
    try {
      const res = await fixture.app.request(`/api/workspaces/${WS}`, { headers: bearer(token) })
      expect(res.status).toBe(403)
      const refusal = capture.records.find(
        (r) => r.msg === 'membership refused' && r.scope === 'daemon-auth',
      )
      expect(refusal?.data).toMatchObject({
        workspaceId: WS,
        rule: 'workspaces (rest)',
        reason: 'requires_person_session',
      })
    } finally {
      capture.restore()
    }
  })
})

describe('SSE transport membership gate', () => {
  it('subscribe refuses the whole request on the first non-admitted key, before any stream lookup', async () => {
    const fixture = await makeApp()
    await addGatingMember(fixture)
    const session = await bindSession(fixture)
    // The streamId names no real stream: a 403 here (not the stream
    // lookup's own 404 unknown_stream) is what proves the gate ran BEFORE
    // the stream lookup, exactly as the route orders it.
    const refused = await fixture.app.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(session.token) },
      body: JSON.stringify({ streamId: 'nonexistent-stream-id', subscribe: [`${WS}/canvas`] }),
    })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'not_a_member' })
  })

  it('message refuses on a non-admitted doc key', async () => {
    const fixture = await makeApp()
    await addGatingMember(fixture)
    const session = await bindSession(fixture)
    const res = await fixture.app.request('/api/sync/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(session.token) },
      body: JSON.stringify({
        streamId: 'nonexistent-stream-id',
        doc: `${WS}/canvas`,
        message: { type: 'client_ready' },
      }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'not_a_member' })
  })

  it('a bound member passes the gate (reaches the real unknown_stream 404)', async () => {
    const fixture = await makeApp()
    const session = await bindSession(fixture)
    const profile = await fixture.members.ensureProfile({
      origin: HOSTED,
      credentialId: session.credentialId,
      displayName: 'Ada',
    })
    await fixture.members.addMember(WS, profile.id)

    const res = await fixture.app.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(session.token) },
      body: JSON.stringify({ streamId: 'nonexistent-stream-id', subscribe: [`${WS}/canvas`] }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'unknown_stream' })
  })

  it('decides once per distinct workspace among several keys', async () => {
    const fixture = await makeApp()
    const session = await bindSession(fixture)
    const profile = await fixture.members.ensureProfile({
      origin: HOSTED,
      credentialId: session.credentialId,
      displayName: 'Ada',
    })
    await fixture.members.addMember(WS, profile.id)
    const listMembers = vi.spyOn(fixture.members, 'listMembers')

    const res = await fixture.app.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(session.token) },
      body: JSON.stringify({
        streamId: 'nonexistent-stream-id',
        subscribe: [`${WS}/canvas`, `${WS}/other-canvas`],
      }),
    })
    expect(res.status).toBe(404) // reaches the real stream lookup: gate passed
    expect(listMembers).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/workspaces filters rather than refuses', () => {
  it('a bound non-member sees the member-gated workspace absent and a member-less one present', async () => {
    const fixture = await makeApp()
    await fixture.serverDeps.documentIndex.createWorkspace({ workspaceId: MEMBER_LESS_WS })
    await addGatingMember(fixture)
    const session = await bindSession(fixture)

    const res = await fixture.app.request('/api/workspaces', { headers: bearer(session.token) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workspaces: { workspaceId: string }[] }
    const ids = body.workspaces.map((w) => w.workspaceId)
    expect(ids).not.toContain(WS)
    expect(ids).toContain(MEMBER_LESS_WS)
  })

  it('the daemon token sees every workspace', async () => {
    const fixture = await makeApp()
    await fixture.serverDeps.documentIndex.createWorkspace({ workspaceId: MEMBER_LESS_WS })
    await addGatingMember(fixture)

    const res = await fixture.app.request('/api/workspaces', {
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    })
    const body = (await res.json()) as { workspaces: { workspaceId: string }[] }
    const ids = body.workspaces.map((w) => w.workspaceId)
    expect(ids).toContain(WS)
    expect(ids).toContain(MEMBER_LESS_WS)
  })
})

describe('the online revoke: L1 removal refuses the next live request (smoke check-4 mirror)', () => {
  it('bound token 401s, a fresh token requires a session, and Ada is no longer admitted once re-asserted', async () => {
    const fixture = await makeApp()
    // Load-bearing: without a SECOND gating member the workspace reverts to
    // origin trust the moment Ada is removed, and every assertion below
    // passes for the wrong reason.
    await addGatingMember(fixture)

    const session = await bindSession(fixture)
    const adaProfile = await fixture.members.ensureProfile({
      origin: HOSTED,
      credentialId: session.credentialId,
      displayName: 'Ada',
    })
    await fixture.members.addMember(WS, adaProfile.id)

    // Sanity: Ada is admitted before removal.
    const before = await fixture.app.request(`/api/workspaces/${WS}`, {
      headers: bearer(session.token),
    })
    expect(before.status).not.toBe(403)

    const removeRes = await fixture.app.request(`/api/workspaces/${WS}/members/${adaProfile.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    })
    expect(removeRes.status).toBe(200)

    // The bound token itself is dead — tokens.revokeBoundTo ended the
    // session synchronously, so it 401s rather than 403.
    const boundAfter = await fixture.app.request(`/api/workspaces/${WS}`, {
      headers: bearer(session.token),
    })
    expect(boundAfter.status).toBe(401)

    // A fresh, UNBOUND pairing token from the same origin requires a person
    // session on the still member-gated workspace.
    const freshRes = await fixture.app.request('/api/pairing/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: HOSTED },
      body: JSON.stringify({ grantType: 'origin' }),
    })
    const { token: freshToken } = pairingTokenResponseSchema.parse(await freshRes.json())
    const freshAsked = await fixture.app.request(`/api/workspaces/${WS}`, {
      headers: bearer(freshToken),
    })
    expect(freshAsked.status).toBe(403)
    expect(await freshAsked.json()).toMatchObject({ error: 'requires_person_session' })

    // Re-asserting Ada's still-pinned passkey on the fresh token binds it to
    // her identity again — and she is refused as a NON-MEMBER now (her
    // L1 membership was removed, but her passkey pin was not), not waved
    // through as an unbound session.
    const reassert = await session.assertSession(freshToken)
    expect(reassert.status).toBe(200)
    const reassertedAsked = await fixture.app.request(`/api/workspaces/${WS}`, {
      headers: bearer(freshToken),
    })
    expect(reassertedAsked.status).toBe(403)
    expect(await reassertedAsked.json()).toMatchObject({ error: 'not_a_member' })
  })
})
