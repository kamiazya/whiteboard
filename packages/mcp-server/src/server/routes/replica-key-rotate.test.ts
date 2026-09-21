/**
 * POST /api/workspaces/:workspaceId/replica-key/rotate (ADR-0042 decision 1,
 * 2026-09-21 addendum): replaces the workspace's key+salt outright, at the
 * `runtime:admin` bar — one step above the plain key route's workspace:read
 * and the tier route's own admin bar, since rotation is at least as
 * consequential as either. Wired through the real
 * `createDaemonAuthMiddleware` chain, the same pattern replica-key.test.ts
 * and membership.test.ts use, sharing this file's `makeApp` fixture.
 */
import { replicaKeyResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import { afterEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { mintMacaroon } from '../security/macaroon.js'
import {
  bindSession,
  DAEMON_TOKEN,
  disposeApp,
  MACAROON_ROOT_KEY,
  makeApp,
  post,
  seedWorkspaceRow,
  WS,
} from './_test-replica-key-app.js'

afterEach(disposeApp)

async function rotate(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  workspaceId = WS,
  headers: Record<string, string> = {},
) {
  return post(app, `/api/workspaces/${workspaceId}/replica-key/rotate`, headers)
}

describe('POST /api/workspaces/:workspaceId/replica-key/rotate', () => {
  it('400s a malformed workspaceId', async () => {
    const { app } = await makeApp()
    const res = await rotate(app, 'not*safe', { Authorization: `Bearer ${DAEMON_TOKEN}` })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_workspace_id' })
  })

  it('404s an unknown workspace', async () => {
    const fixture = await makeApp({ known: [] })
    const res = await rotate(fixture.app, WS, { Authorization: `Bearer ${DAEMON_TOKEN}` })
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'unknown_workspace' })
  })

  it('rotation is not gated on tier — a no-offline workspace still rotates 200', async () => {
    const fixture = await makeApp({ defaultTier: 'no-offline' })
    const res = await rotate(fixture.app, WS, { Authorization: `Bearer ${DAEMON_TOKEN}` })
    expect(res.status).toBe(200)
  })

  it('answers a fresh keyId, different from the one the plain key route reported before rotation', async () => {
    const fixture = await makeApp()
    const before = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    const beforeBody = replicaKeyResponseSchema.parse(await before.json())

    const res = await rotate(fixture.app, WS, { Authorization: `Bearer ${DAEMON_TOKEN}` })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keyId: string }
    expect(body.keyId).not.toBe(beforeBody.keyId)
  })

  // The two routes must agree about which key is CURRENT: a caller that
  // rotates and then re-fetches the plain key route sees the SAME keyId the
  // rotate response just reported, and a fresh key value.
  it('the plain key route reports the same keyId the rotate response just answered, with a fresh key', async () => {
    const fixture = await makeApp()
    const before = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    const beforeBody = replicaKeyResponseSchema.parse(await before.json())

    const rotated = (await (
      await rotate(fixture.app, WS, { Authorization: `Bearer ${DAEMON_TOKEN}` })
    ).json()) as { keyId: string }

    const after = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    const afterBody = replicaKeyResponseSchema.parse(await after.json())
    expect(afterBody.keyId).toBe(rotated.keyId)
    expect(afterBody.workspaceKey).not.toBe(beforeBody.workspaceKey)
  })

  it('logs a durable audit record naming the workspace and the new keyId, and never the key or salt bytes', async () => {
    const capture = captureLogsForTests('debug')
    try {
      const fixture = await makeApp()
      const res = await rotate(fixture.app, WS, { Authorization: `Bearer ${DAEMON_TOKEN}` })
      const body = (await res.json()) as { keyId: string }
      const record = capture.records.find(
        (r) => r.msg === 'replica-key rotated' && r.scope === 'replica-key',
      )
      expect(record?.data).toMatchObject({ workspaceId: WS, keyId: body.keyId })

      const keyRes = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
      })
      const keyBody = replicaKeyResponseSchema.parse(await keyRes.json())
      const serialized = JSON.stringify(capture.records)
      expect(serialized).not.toContain(keyBody.workspaceKey)
      expect(serialized).not.toContain(keyBody.workspaceKeySalt)
    } finally {
      capture.restore()
    }
  })

  // The mutation check for the bar itself: flipping the registry rule's
  // `decide` to `always('workspace:write')` must make this fail.
  it('refuses a macaroon caveated to workspace:write, not the runtime:admin this route actually needs', async () => {
    const fixture = await makeApp()
    const scoped = await mintMacaroon({
      rootKey: MACAROON_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['workspace:write'] }],
    })
    const res = await rotate(fixture.app, WS, { Authorization: `Bearer ${scoped}` })
    expect(res.status).toBe(401)
  })

  // ...and refused at workspace:read too — the bar the PLAIN key route
  // sits at is not enough for rotation either.
  it('refuses a macaroon caveated to workspace:read, the plain key route’s own bar', async () => {
    const fixture = await makeApp()
    const scoped = await mintMacaroon({
      rootKey: MACAROON_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['workspace:read'] }],
    })
    const res = await rotate(fixture.app, WS, { Authorization: `Bearer ${scoped}` })
    expect(res.status).toBe(401)
  })

  it('admits a macaroon caveated with runtime:admin, through the real middleware', async () => {
    const fixture = await makeApp()
    const scoped = await mintMacaroon({
      rootKey: MACAROON_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['runtime:admin'] }],
    })
    const res = await rotate(fixture.app, WS, { Authorization: `Bearer ${scoped}` })
    expect(res.status).toBe(200)
  })

  // The bar is runtime:admin, not member-scoped — a passkey-bound member
  // session (ALL_AUTH_SCOPES under the accepted v1 posture) still reaches
  // it, the same honest limit #1752 recorded for the tier route: this bar
  // does not today separate an operator from a paired browser session.
  it('a passkey-bound member session (ALL_AUTH_SCOPES) also clears the bar, per the accepted v1 posture', async () => {
    const fixture = await makeApp()
    const { token } = await bindSession(fixture)
    const res = await rotate(fixture.app, WS, {
      Authorization: `Bearer ${token}`,
      Origin: 'https://latest.kamiazya-whiteboard.pages.dev',
    })
    expect(res.status).toBe(200)
  })

  it('never mints a workspaces row as a side effect', async () => {
    const fixture = await makeApp()
    await rotate(fixture.app, WS, { Authorization: `Bearer ${DAEMON_TOKEN}` })
    const rows = await fixture.db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', WS)
      .execute()
    expect(rows).toEqual([])
  })

  it('never touches workspaces.replicaTier for a workspace that has one', async () => {
    const fixture = await makeApp()
    await seedWorkspaceRow(fixture)
    await fixture.keys.setTier(WS, 'bounded')
    await rotate(fixture.app, WS, { Authorization: `Bearer ${DAEMON_TOKEN}` })
    expect(await fixture.keys.tierFor(WS)).toBe('bounded')
  })
})
