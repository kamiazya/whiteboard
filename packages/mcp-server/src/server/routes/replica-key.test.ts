/**
 * POST /api/workspaces/:workspaceId/replica-key (ADR-0042 decisions 1/3/5,
 * ADR-0043 decision 3): the local daemon hands its one person — whoever holds
 * the operator-issued token — the workspace's read-plane content key, per
 * tier. Wired through the real `createDaemonAuthMiddleware` chain, so the
 * route-scope-registry rule is exercised rather than only pinned in
 * isolation.
 *
 * PUT /api/workspaces/:workspaceId/replica-tier (ADR-0042 decision 1
 * addendum): sets or clears that tier itself, at the `runtime:admin` bar —
 * narrower than the POST route above, and enforced the same way, through
 * the real middleware rather than only `route-scope-registry.test.ts`'s
 * direct classification.
 *
 * The rotation route (POST .../replica-key/rotate) has its own file,
 * replica-key-rotate.test.ts — both share the `_test-replica-key-app.ts`
 * fixture.
 */
import {
  replicaKeyResponseSchema,
  setReplicaTierResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { mintMacaroon } from '../security/macaroon.js'
import {
  DAEMON_TOKEN,
  disposeApp,
  MACAROON_ROOT_KEY,
  makeApp,
  post,
  put,
  seedWorkspaceRow,
  WS,
} from './_test-replica-key-app.js'

afterEach(disposeApp)

describe('POST /api/workspaces/:workspaceId/replica-key', () => {
  it('400s a malformed workspaceId', async () => {
    const { app } = await makeApp()
    const res = await post(app, '/api/workspaces/not*safe/replica-key', {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_workspace_id' })
  })

  it('404s an unknown workspace', async () => {
    const { app } = await makeApp({ known: [] })
    const res = await post(app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'workspace_not_found' })
  })

  it('the daemon token gets 200 with the same key on every call', async () => {
    const { app } = await makeApp()
    const first = await post(app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    expect(first.status).toBe(200)
    const firstBody = replicaKeyResponseSchema.parse(await first.json())
    expect(firstBody.tier).toBe('offline')
    expect(firstBody.leaseExpiresAt).toBeUndefined()

    const second = await post(app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    const secondBody = replicaKeyResponseSchema.parse(await second.json())
    expect(secondBody).toEqual(firstBody)
  })

  it('two concurrent daemon-token requests answer the same key', async () => {
    const { app } = await makeApp()
    const [a, b] = await Promise.all([
      post(app, `/api/workspaces/${WS}/replica-key`, { Authorization: `Bearer ${DAEMON_TOKEN}` }),
      post(app, `/api/workspaces/${WS}/replica-key`, { Authorization: `Bearer ${DAEMON_TOKEN}` }),
    ])
    expect(replicaKeyResponseSchema.parse(await a.json())).toEqual(
      replicaKeyResponseSchema.parse(await b.json()),
    )
  })

  // An anonymous grant (an open daemon, no WHITEBOARD_DAEMON_TOKEN
  // configured) is treated the same as the daemon token — an operator
  // running with no token already has full authority over the data this key
  // decrypts.
  it('an anonymous grant (open daemon) gets the key, the same as the daemon token', async () => {
    const fixture = await makeApp({ openDaemon: true })
    const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`)
    expect(res.status).toBe(200)
    const body = replicaKeyResponseSchema.parse(await res.json())
    expect(body.tier).toBe('offline')
  })

  it('a no-offline default refuses and mints no row', async () => {
    const fixture = await makeApp({ defaultTier: 'no-offline' })
    const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'replica_not_allowed' })
    const rows = await fixture.db.selectFrom('workspaceReplicaKeys').selectAll().execute()
    expect(rows).toEqual([])
  })

  it('a per-workspace override beats the env default', async () => {
    const fixture = await makeApp({ defaultTier: 'no-offline' })
    await fixture.db
      .insertInto('workspaces')
      .values({
        id: WS,
        displayName: null,
        segment: null,
        createdAt: 0,
        updatedAt: 0,
        replicaTier: 'offline',
      })
      .execute()
    const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    expect(res.status).toBe(200)
  })

  it('a bounded tier carries leaseExpiresAt = now + leaseTtlMs', async () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-09-21T00:00:00.000Z')
      vi.setSystemTime(now)
      const fixture = await makeApp({ defaultTier: 'bounded', leaseTtlMs: 3_600_000 })
      const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
      })
      expect(res.status).toBe(200)
      const body = replicaKeyResponseSchema.parse(await res.json())
      expect(body.tier).toBe('bounded')
      expect(body.leaseExpiresAt).toBe(new Date(now.getTime() + 3_600_000).toISOString())
    } finally {
      vi.useRealTimers()
    }
  })

  it('never logs the key bytes', async () => {
    const capture = captureLogsForTests('debug')
    try {
      const fixture = await makeApp()
      const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
      })
      const body = replicaKeyResponseSchema.parse(await res.json())
      const serialized = JSON.stringify(capture.records)
      expect(serialized).not.toContain(body.workspaceKey)
      expect(serialized).not.toContain(body.workspaceKeySalt)
    } finally {
      capture.restore()
    }
  })

  it('refuses a macaroon caveated below workspace:read', async () => {
    const { app } = await makeApp()
    const underScoped = await mintMacaroon({
      rootKey: MACAROON_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['runtime:read'] }],
    })
    const res = await post(app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${underScoped}`,
    })
    expect(res.status).toBe(401)
  })
})

describe('PUT /api/workspaces/:workspaceId/replica-tier', () => {
  it('400s a malformed workspaceId', async () => {
    const { app } = await makeApp()
    const res = await put(
      app,
      '/api/workspaces/not*safe/replica-tier',
      { tier: 'offline' },
      {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
      },
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_workspace_id' })
  })

  it('404s an unknown workspace', async () => {
    const { app } = await makeApp({ known: [] })
    const res = await put(
      app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: 'offline' },
      {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
      },
    )
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'workspace_not_found' })
  })

  it('400s a body that is not valid JSON', async () => {
    const fixture = await makeApp()
    const res = await fixture.app.request(`/api/workspaces/${WS}/replica-tier`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DAEMON_TOKEN}` },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_body' })
  })

  it('400s an unknown tier value', async () => {
    const fixture = await makeApp()
    const res = await put(
      fixture.app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: 'full-offline' },
      { Authorization: `Bearer ${DAEMON_TOKEN}` },
    )
    expect(res.status).toBe(400)
  })

  it('400s a body carrying an undeclared field (.strict())', async () => {
    const fixture = await makeApp()
    const res = await put(
      fixture.app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: 'bounded', leaseExpiresAt: '2026-09-28T00:00:00.000Z' },
      { Authorization: `Bearer ${DAEMON_TOKEN}` },
    )
    expect(res.status).toBe(400)
  })

  it('sets the tier and echoes it back with the resolved effectiveTier', async () => {
    const fixture = await makeApp()
    await seedWorkspaceRow(fixture)
    const res = await put(
      fixture.app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: 'no-offline' },
      { Authorization: `Bearer ${DAEMON_TOKEN}` },
    )
    expect(res.status).toBe(200)
    expect(setReplicaTierResponseSchema.parse(await res.json())).toEqual({
      tier: 'no-offline',
      effectiveTier: 'no-offline',
    })
  })

  it('logs a durable audit record naming the workspace and resulting effective tier on every successful change', async () => {
    const capture = captureLogsForTests('warning')
    try {
      const fixture = await makeApp()
      await seedWorkspaceRow(fixture)
      const res = await put(
        fixture.app,
        `/api/workspaces/${WS}/replica-tier`,
        { tier: 'no-offline' },
        { Authorization: `Bearer ${DAEMON_TOKEN}` },
      )
      expect(res.status).toBe(200)
      const record = capture.records.find(
        (r) => r.msg === 'replica-tier changed' && r.scope === 'replica-key',
      )
      expect(record?.data).toMatchObject({
        workspaceId: WS,
        tier: 'no-offline',
        effectiveTier: 'no-offline',
      })
    } finally {
      capture.restore()
    }
  })

  it('clearing (tier: null) falls back to the constructor default', async () => {
    const fixture = await makeApp({ defaultTier: 'offline' })
    await seedWorkspaceRow(fixture)
    await put(
      fixture.app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: 'no-offline' },
      { Authorization: `Bearer ${DAEMON_TOKEN}` },
    )
    const res = await put(
      fixture.app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: null },
      { Authorization: `Bearer ${DAEMON_TOKEN}` },
    )
    expect(res.status).toBe(200)
    expect(setReplicaTierResponseSchema.parse(await res.json())).toEqual({
      tier: null,
      effectiveTier: 'offline',
    })
  })

  // The whole point: the write reaches the SAME reader `POST .../replica-key`
  // already consults, not merely the `workspaces` column. No prior POST is
  // made here, so a passing refusal-with-no-row-minted is not merely "no
  // NEW row" hiding one an earlier fetch already created.
  it('setting no-offline turns a replica-key request into a 403 with no key minted, and clearing restores it', async () => {
    const fixture = await makeApp()
    await seedWorkspaceRow(fixture)

    const setRes = await put(
      fixture.app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: 'no-offline' },
      { Authorization: `Bearer ${DAEMON_TOKEN}` },
    )
    expect(setRes.status).toBe(200)

    const after = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    expect(after.status).toBe(403)
    expect((await after.json()) as { error: string }).toMatchObject({
      error: 'replica_not_allowed',
    })
    expect(
      await fixture.db
        .selectFrom('workspaceReplicaKeys')
        .selectAll()
        .where('workspaceId', '=', WS)
        .execute(),
    ).toEqual([])

    const clearRes = await put(
      fixture.app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: null },
      { Authorization: `Bearer ${DAEMON_TOKEN}` },
    )
    expect(clearRes.status).toBe(200)

    const restored = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    })
    expect(restored.status).toBe(200)
    expect(
      await fixture.db
        .selectFrom('workspaceReplicaKeys')
        .selectAll()
        .where('workspaceId', '=', WS)
        .execute(),
    ).toHaveLength(1)
  })

  // The whole point of the `runtime:admin` bar over `workspace:write`: a
  // macaroon caveated to exactly the scope the broader fallback rule would
  // have granted must still be refused here. Flipping the registry rule's
  // `decide` to `always('workspace:write')` must make this fail — the
  // mutation check for the bar itself.
  it('refuses a macaroon caveated to workspace:write, not the runtime:admin this route actually needs', async () => {
    const fixture = await makeApp()
    const scoped = await mintMacaroon({
      rootKey: MACAROON_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['workspace:write'] }],
    })
    const res = await put(
      fixture.app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: 'offline' },
      { Authorization: `Bearer ${scoped}` },
    )
    expect(res.status).toBe(401)
  })

  it('admits a macaroon caveated with runtime:admin, through the real middleware', async () => {
    const fixture = await makeApp()
    await seedWorkspaceRow(fixture)
    const scoped = await mintMacaroon({
      rootKey: MACAROON_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['runtime:admin'] }],
    })
    const res = await put(
      fixture.app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: 'offline' },
      { Authorization: `Bearer ${scoped}` },
    )
    expect(res.status).toBe(200)
  })
})
