// Shared test fixture for the `/replica-key` route family
// (replica-key.test.ts, replica-key-rotate.test.ts): builds the real
// `createDaemonAuthMiddleware` chain over an isolated database, the same
// pattern `membership.test.ts` uses, so the route-scope-registry rules are
// exercised rather than only pinned in isolation. Extracted so a second test
// file (rotation) does not duplicate the pairing/webauthn wiring — see
// `file-size-budget.test.ts`'s ledger for `replica-key.test.ts`.
//
// Named with the leading `_test-` prefix (the same convention `store/db/
// test-helpers.ts`'s sibling `_test-helpers.ts` uses) because it imports
// `expect` from vitest: `tsconfig.server.json` excludes `_test-*.ts` from the
// production compile, and a plain `*-test-app.ts` name would not have been
// excluded — the production typecheck caught this the first time, on a
// fixture stub's `verifyAccessToken` shape that was never checked while the
// same code lived inside a `.test.ts` file.
//
// `createIsolatedDb` is imported DYNAMICALLY, the same move `_test-
// helpers.ts`'s `seedWorkspaceRow` already makes for the same reason: this
// file sits under `routes/`, which `adapter-mechanic-check.ts` scans as an
// ADAPTER tree (ADR-0018) — a static import of the db test helper module
// reads as an adapter reaching a mechanic, which this fixture is not.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pairingTokenResponseSchema,
  sessionAssertChallengeResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import { Hono } from 'hono'
import { expect } from 'vitest'
import {
  buildAssertion,
  registrationFor,
  WEBAUTHN_FLAG_BE,
  WEBAUTHN_FLAG_UP,
  WEBAUTHN_FLAG_UV,
} from '../../shared/test-utils/webauthn-fixtures.js'
import { createCredentialResolver } from '../security/credential-resolver.js'
import { createDaemonIdentity } from '../security/daemon-identity.js'
import { createMemberProfileStore } from '../security/member-profile-store.js'
import { createPairingGrantStore } from '../security/pairing-grant-store.js'
import { createPairingCodeStore, createPairingTokenStore } from '../security/pairing-session.js'
import { createWebAuthnCredentialStore } from '../security/webauthn-credential-store.js'
import { createWorkspaceReplicaKeyStore } from '../security/workspace-replica-key-store.js'
import { createDaemonAuthMiddleware } from './auth.js'
import { createMembershipRouter } from './membership.js'
import { createPairingRouter } from './pairing.js'
import { createReplicaKeyRouter } from './replica-key.js'

// Type-only: `import type(...)`'s target module has no `from`, so it does
// not match the mechanic scan's pattern the way a value import would.
type IsolatedDbModule = typeof import('../store/db/test-helpers.js')
type IsolatedDbHandle = Awaited<ReturnType<IsolatedDbModule['createIsolatedDb']>>

export const WS = 'ws-1'
export const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'
export const HOST = new URL(HOSTED).hostname
export const FLAGS = WEBAUTHN_FLAG_UP | WEBAUTHN_FLAG_UV | WEBAUTHN_FLAG_BE
export const DAEMON_TOKEN = 'the-daemon-token'
export const MACAROON_ROOT_KEY = new Uint8Array(32).fill(7)
export const OAUTH_TOKEN = 'the-oauth-token'
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

let dir: string | undefined
let dbHandle: IsolatedDbHandle | undefined

export interface MakeAppOptions {
  known?: readonly string[]
  defaultTier?: 'no-offline' | 'offline' | 'bounded'
  leaseTtlMs?: number
  /** No daemon token configured (an open daemon) — every caller resolves to
   *  an `anonymous` grant, ALL_AUTH_SCOPES, the same bypass DAEMON_TOKEN
   *  gets. Default false, matching every other test using this fixture. */
  openDaemon?: boolean
}

export async function makeApp(options: MakeAppOptions = {}) {
  const known = options.known ?? [WS]
  dir = mkdtempSync(join(tmpdir(), 'replica-key-routes-'))
  const { createIsolatedDb } = await import('../store/db/test-helpers.js')
  dbHandle = await createIsolatedDb({ dataDir: dir })
  const grants = createPairingGrantStore(dir)
  const codes = createPairingCodeStore()
  const tokens = createPairingTokenStore()
  const identity = createDaemonIdentity({ dataDir: dir })
  const credentials = createWebAuthnCredentialStore(dir)
  const members = createMemberProfileStore(dbHandle.db)
  const keys = createWorkspaceReplicaKeyStore(dbHandle.db, {
    defaultTier: options.defaultTier ?? 'offline',
  })
  const workspaceExists = async (id: string) => known.includes(id)

  const credentialResolver = createCredentialResolver({
    ...(options.openDaemon ? {} : { daemonToken: DAEMON_TOKEN }),
    macaroonRootKey: MACAROON_ROOT_KEY,
    pairingTokens: tokens,
    grantStore: {
      verifyAccessToken: (token: string) =>
        token === OAUTH_TOKEN ? { scopes: ['workspace:read'] as const, clientId: 'agent-1' } : null,
    },
  })

  const pairing = createPairingRouter({ grants, codes, tokens, credentials, identity, members })
  const membership = createMembershipRouter({ members, tokens, credentials, workspaceExists })
  const replicaKey = createReplicaKeyRouter({
    keys,
    members,
    leaseTtlMs: options.leaseTtlMs ?? SEVEN_DAYS_MS,
    workspaceExists,
    credentialResolver,
  })

  const authed = new Hono()
  authed.use('/api/*', createDaemonAuthMiddleware(credentialResolver))
  authed.route('/', pairing)
  authed.route('/', membership)
  authed.route('/', replicaKey)

  return { app: authed, grants, tokens, credentials, members, keys, db: dbHandle.db }
}

/** Register as `afterEach(disposeApp)` in every file that calls `makeApp`. */
export async function disposeApp(): Promise<void> {
  await dbHandle?.dispose()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  dbHandle = undefined
}

export async function post(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  path: string,
  headers: Record<string, string> = {},
) {
  return app.request(path, { method: 'POST', headers })
}

export async function put(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** `keys.setTier` UPDATEs an existing `workspaces` row (see its own header:
 *  rows are minted lazily off document writes). This fixture's
 *  `workspaceExists` is a plain array check decoupled from that table —
 *  unlike production, where the same table backs both — so a test that
 *  writes a tier through the route has to seed the row itself. */
export async function seedWorkspaceRow(fixture: Awaited<ReturnType<typeof makeApp>>, id = WS) {
  await fixture.db
    .insertInto('workspaces')
    .values({ id, displayName: null, segment: null, createdAt: 0, updatedAt: 0, replicaTier: null })
    .execute()
}

/** Full pairing-token -> passkey-bound-session chain, reused across tests
 *  that need a real bound session (mirrors membership.test.ts's chain). */
export async function bindSession(fixture: Awaited<ReturnType<typeof makeApp>>) {
  fixture.grants.addGrant(HOSTED)
  const reg = registrationFor(HOST)
  const { keypair, ...registration } = reg
  const credentialId = registration.credentialId

  // /api/pairing/token is the deliberately PUBLIC route (route-scope-
  // registry.ts): it must be reachable by an origin holding no bearer yet.
  // The token it mints carries ALL_AUTH_SCOPES, which is what then clears
  // the runtime:admin bar credential registration sits behind.
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
    return fixture.app.request('/api/pairing/session-assert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
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

  const bound = await assertSession()
  expect(bound.status).toBe(200)
  return { token, credentialId, origin: HOSTED }
}

/** Seeds a second, unrelated member directly through the store so the
 *  workspace stays member-GATED for a test that is not about that member —
 *  without this, a workspace with zero members admits everyone (S8). */
export async function addGatingMember(fixture: Awaited<ReturnType<typeof makeApp>>) {
  const profile = await fixture.members.ensureProfile({
    origin: HOSTED,
    credentialId: 'gating-member-cred',
    displayName: 'Gating Member',
  })
  await fixture.members.addMember(WS, profile.id)
  return profile
}
