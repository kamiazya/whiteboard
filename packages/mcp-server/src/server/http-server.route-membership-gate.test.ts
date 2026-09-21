import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findAvailablePort } from '../cli/daemon-run.js'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { createStoreLocalModule } from '../di/store-local.module.js'
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
import { createMemberProfileStore } from './security/member-profile-store.js'
import { createPairingGrantStore } from './security/pairing-grant-store.js'
import { getDb } from './store/db/index.js'

const _FLAGS = WEBAUTHN_FLAG_UP | WEBAUTHN_FLAG_UV | WEBAUTHN_FLAG_BE

// A base distinct from every other http-server*.test.ts file's own range
// (see http-server.test.ts's comment for why ports advance monotonically
// rather than reusing one).
let nextPortBase = 5800
async function acquirePort(): Promise<number> {
  const port = await findAvailablePort(nextPortBase)
  nextPortBase = port + 1
  return port
}

describe('startHttpServer route membership gate — app.ts admit wiring (S8 slice 2)', () => {
  const HOSTED = 'https://route-gate.kamiazya-whiteboard.pages.dev'
  const DAEMON_TOKEN = 'the-daemon-token'
  const WS_GATED = 'ws-route-gated'
  const WS_OPEN = 'ws-route-open'
  let dir: string
  let running: RunningServer | undefined

  beforeEach(() => {
    dir = claimIsolatedDataDir('http-server-route-membership')
  })

  afterEach(async () => {
    await running?.close()
    running = undefined
    releaseIsolatedDataDir(dir)
  })

  const bindSession = (port: number) => bindPasskeySessionOverHttp(port, HOSTED)

  it('GET /api/workspaces filters a member-gated workspace, and POST /api/sync/subscribe refuses on it, over a real daemon', async () => {
    createPairingGrantStore(dir).addGrant(HOSTED)
    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1', token: DAEMON_TOKEN })

    // Seeded AFTER startup, off the same post-migration handle the server
    // itself opened (`getDb` memoizes per data dir) — same pattern as
    // `http-server.ws-membership-gate.test.ts`.
    const db = await getDb(dir)
    const documentIndex = resolveServerDeps(
      createContainer(createStoreLocalModule({ db, blobDir: dir })),
    ).documentIndex
    await documentIndex.createWorkspace({ workspaceId: WS_GATED })
    await documentIndex.createWorkspace({ workspaceId: WS_OPEN })

    const members = createMemberProfileStore(db)
    const gatingProfile = await members.ensureProfile({
      origin: HOSTED,
      credentialId: 'gating-member-cred',
      displayName: 'Gating Member',
    })
    await members.addMember(WS_GATED, gatingProfile.id)

    const session = await bindSession(port)

    // GET /api/workspaces: the list-filter half of the admit wiring
    // (createDocumentRouter -> createWorkspacesRouter).
    const listRes = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      headers: { Authorization: `Bearer ${session.token}`, Origin: HOSTED },
    })
    expect(listRes.status).toBe(200)
    const body = (await listRes.json()) as { workspaces: { workspaceId: string }[] }
    const ids = body.workspaces.map((w) => w.workspaceId)
    expect(ids).not.toContain(WS_GATED)
    expect(ids).toContain(WS_OPEN)

    // POST /api/sync/subscribe: the sync-sse half of the admit wiring
    // (createSyncSseRouter). The stream id names nothing real; a 403 here
    // (not the transport's own 404 unknown_stream) proves the gate ran.
    const subscribeRes = await fetch(`http://127.0.0.1:${port}/api/sync/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
        Origin: HOSTED,
      },
      body: JSON.stringify({
        streamId: 'nonexistent-stream-id',
        subscribe: [`${WS_GATED}/canvas`],
      }),
    })
    expect(subscribeRes.status).toBe(403)
    expect(await subscribeRes.json()).toMatchObject({ error: 'not_a_member' })

    // Control: the daemon token bypasses membership on both surfaces,
    // proving the refusal above is really about membership and not, say,
    // the workspace id or the route itself.
    const daemonListRes = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    })
    const daemonBody = (await daemonListRes.json()) as { workspaces: { workspaceId: string }[] }
    expect(daemonBody.workspaces.map((w) => w.workspaceId)).toContain(WS_GATED)
  })
})
