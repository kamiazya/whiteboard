/**
 * S8 slice 2: the membership gate on the real WS upgrade path. Split out of
 * `http-server.test.ts` (its own module, `file-size-budget.test.ts`'s
 * 800-line ceiling) rather than a describe block added there.
 */
import { request } from 'node:http'
import { pairingTokenResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import {
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '@kamiazya/whiteboard-daemon-client/ws-protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findAvailablePort } from '../cli/daemon-run.js'
import { bindPasskeySessionOverHttp } from '../shared/test-utils/bind-passkey-session.js'
import {
  claimIsolatedDataDir,
  releaseIsolatedDataDir,
} from '../shared/test-utils/isolated-data-dir.js'
import {
  WEBAUTHN_FLAG_BE,
  WEBAUTHN_FLAG_UP,
  WEBAUTHN_FLAG_UV,
} from '../shared/test-utils/webauthn-fixtures.js'
import { type RunningServer, startHttpServer } from './http-server.js'
import { createMemberProfileStore, passkeyBinding } from './security/member-profile-store.js'
import { createPairingGrantStore } from './security/pairing-grant-store.js'
import { getDb } from './store/db/index.js'
import { tenantRoot } from './tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from './tenant/id.js'

const _FLAGS = WEBAUTHN_FLAG_UP | WEBAUTHN_FLAG_UV | WEBAUTHN_FLAG_BE

// A base distinct from http-server.test.ts (4100) and
// http-server.macaroon.test.ts (4700) — see http-server.test.ts's own
// comment for why ports advance monotonically rather than reusing one.
let nextPortBase = 5300
async function acquirePort(): Promise<number> {
  const port = await findAvailablePort(nextPortBase)
  nextPortBase = port + 1
  return port
}

// Isolated data dir because it seeds a pairing grant + member directly
// against the daemon's own on-disk stores, which the shared-worker default
// dir (http-server.test.ts's describe blocks) must not see.
describe('startHttpServer WS upgrade membership gate (S8 slice 2)', () => {
  const HOSTED = 'https://member-gate.kamiazya-whiteboard.pages.dev'
  const DAEMON_TOKEN = 'the-daemon-token'
  let dir: string
  let running: RunningServer | undefined

  beforeEach(() => {
    dir = claimIsolatedDataDir('http-server-ws-membership')
  })

  afterEach(async () => {
    await running?.close()
    running = undefined
    releaseIsolatedDataDir(dir)
  })

  function attemptWsUpgradeWithBody(
    port: number,
    protocolHeader: string,
    origin: string,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/ws/ws-member-gated/canvas',
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Protocol': protocolHeader,
          Origin: origin,
        },
      })
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve({ status: res.statusCode ?? 0, body: undefined })
      })
      req.on('response', (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          resolve({
            status: res.statusCode ?? 0,
            body: raw.length > 0 ? JSON.parse(raw) : undefined,
          })
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('refuses a bound-but-unbound-to-a-passkey pairing session on a member-gated workspace, admits the daemon token', async () => {
    // The pairing grant is seeded on disk before the server starts, same as
    // production: a browser must already be paired before it can mint a
    // pairing token at all.
    createPairingGrantStore(tenantRoot(dir, SELF_HOST_TENANT_ID)).addGrant(HOSTED)

    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1', token: DAEMON_TOKEN })

    // Seeded AFTER startup, off the same post-migration handle the server
    // itself opened (`getDb` memoizes per data dir) — the workspace never
    // needs to be REGISTERED for the WS upgrade gate, which judges the
    // handle in the URL directly.
    const members = createMemberProfileStore(await getDb(dir))
    const profile = await members.ensureProfile({
      binding: passkeyBinding(HOSTED, 'gating-member-cred'),
      displayName: 'Gating Member',
    })
    await members.addMember('ws-member-gated', profile.id)

    const tokenRes = await fetch(`http://127.0.0.1:${port}/api/pairing/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: HOSTED },
      body: JSON.stringify({ grantType: 'origin' }),
    })
    const { token } = pairingTokenResponseSchema.parse(await tokenRes.json())

    const refused = await attemptWsUpgradeWithBody(
      port,
      `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${token}`,
      HOSTED,
    )
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ error: 'requires_person_session' })

    // Control: the daemon token bypasses membership entirely (an
    // operator-issued kind), proving the refusal above is really about the
    // pairing session and not, say, the workspace handle or the Origin.
    const admitted = await attemptWsUpgradeWithBody(
      port,
      `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${DAEMON_TOKEN}`,
      HOSTED,
    )
    expect(admitted.status).toBe(101)
  })

  const bindSession = bindPasskeySessionOverHttp

  it('refuses a bound session that is not a member of a member-gated workspace (not_a_member)', async () => {
    createPairingGrantStore(tenantRoot(dir, SELF_HOST_TENANT_ID)).addGrant(HOSTED)
    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1', token: DAEMON_TOKEN })

    const members = createMemberProfileStore(await getDb(dir))
    // A gating member distinct from the bound session below, so the
    // workspace stays member-gated rather than reverting to origin trust.
    const gatingProfile = await members.ensureProfile({
      binding: passkeyBinding(HOSTED, 'gating-member-cred'),
      displayName: 'Gating Member',
    })
    await members.addMember('ws-member-gated', gatingProfile.id)

    const session = await bindSession(port, HOSTED)

    const refused = await attemptWsUpgradeWithBody(
      port,
      `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${session.token}`,
      HOSTED,
    )
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ error: 'not_a_member' })
  })

  it('completes the real WS upgrade for a bound session that IS an admitted member', async () => {
    createPairingGrantStore(tenantRoot(dir, SELF_HOST_TENANT_ID)).addGrant(HOSTED)
    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1', token: DAEMON_TOKEN })

    const members = createMemberProfileStore(await getDb(dir))
    const session = await bindSession(port, HOSTED)
    const profile = await members.ensureProfile({
      binding: passkeyBinding(HOSTED, session.credentialId),
      displayName: 'Ada',
    })
    await members.addMember('ws-member-gated', profile.id)

    const admitted = await attemptWsUpgradeWithBody(
      port,
      `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${session.token}`,
      HOSTED,
    )
    expect(admitted.status).toBe(101)
  })

  it('admits a bare pairing session on a member-LESS workspace', async () => {
    createPairingGrantStore(tenantRoot(dir, SELF_HOST_TENANT_ID)).addGrant(HOSTED)
    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1', token: DAEMON_TOKEN })

    const tokenRes = await fetch(`http://127.0.0.1:${port}/api/pairing/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: HOSTED },
      body: JSON.stringify({ grantType: 'origin' }),
    })
    const { token } = pairingTokenResponseSchema.parse(await tokenRes.json())

    const admitted = await attemptWsUpgradeWithBody(
      port,
      `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${token}`,
      HOSTED,
    )
    expect(admitted.status).toBe(101)
  })
})
