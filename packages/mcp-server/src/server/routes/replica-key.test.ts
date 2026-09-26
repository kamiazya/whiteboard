/**
 * POST /api/workspaces/:workspaceId/replica-key (ADR-0042 decisions 1/3/5,
 * ADR-0043 decision 3): the daemon hands a member's session the workspace's
 * read-plane content key, per tier, and withholds it once L1 removal has
 * taken effect. Wired through the real `createDaemonAuthMiddleware` chain —
 * the same pattern `membership.test.ts` uses — so the route-scope-registry
 * rule is exercised rather than only pinned in isolation.
 *
 * PUT /api/workspaces/:workspaceId/replica-tier (ADR-0042 decision 1
 * addendum): sets or clears that tier itself, at the `runtime:admin` bar —
 * narrower than the POST route above, and enforced the same way, through
 * the real middleware rather than only `route-scope-registry.test.ts`'s
 * direct classification.
 *
 * The rotation route (POST .../replica-key/rotate) has its own file,
 * replica-key-rotate.test.ts — both share the `_test-replica-key-app.ts`
 * fixture rather than each rebuilding the pairing/webauthn wiring. That
 * fixture is named with the leading `_test-` prefix `tsconfig.server.json`
 * excludes: it imports `expect` from vitest, which the production compile
 * must never see.
 */
import type { AddMemberRequest } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { memberProfileSummarySchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { pairingTokenResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import {
  replicaKeyResponseSchema,
  setReplicaTierResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { mintMacaroon } from '../security/macaroon.js'
import {
  addGatingMember,
  bindSession,
  DAEMON_TOKEN,
  disposeApp,
  HOSTED,
  MACAROON_ROOT_KEY,
  makeApp,
  OAUTH_TOKEN,
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
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'unknown_workspace' })
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

  // The module header's other bypass arm: an anonymous grant (an open
  // daemon, no WHITEBOARD_DAEMON_TOKEN configured) is treated the same as
  // the daemon token — an operator running with no token already has full
  // authority over the data this key decrypts, so membership is never
  // consulted. The daemon-token half above is covered repeatedly; this one
  // was not covered at all.
  it('an anonymous grant (open daemon) bypasses membership entirely, the same as the daemon token', async () => {
    const fixture = await makeApp({ openDaemon: true })
    const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`)
    expect(res.status).toBe(200)
    const body = replicaKeyResponseSchema.parse(await res.json())
    expect(body.tier).toBe('offline')
  })

  it('member-less workspace: an unbound pairing session gets 200 (origin trust, S8)', async () => {
    const fixture = await makeApp()
    fixture.grants.addGrant(HOSTED)
    const tokenRes = await fixture.app.request('/api/pairing/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: HOSTED },
      body: JSON.stringify({ grantType: 'origin' }),
    })
    const { token } = pairingTokenResponseSchema.parse(await tokenRes.json())

    const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${token}`,
      Origin: HOSTED,
    })
    expect(res.status).toBe(200)
  })

  it('member-gated workspace: refuses an unbound pairing session', async () => {
    const fixture = await makeApp()
    await addGatingMember(fixture)
    fixture.grants.addGrant(HOSTED)
    const tokenRes = await fixture.app.request('/api/pairing/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: HOSTED },
      body: JSON.stringify({ grantType: 'origin' }),
    })
    const { token } = pairingTokenResponseSchema.parse(await tokenRes.json())

    const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${token}`,
      Origin: HOSTED,
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'requires_person_session',
    })
  })

  it('an OAuth grant carrying workspace:read is operator-issued and gets 200 even on a member-gated workspace', async () => {
    const fixture = await makeApp()
    await addGatingMember(fixture)
    const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${OAUTH_TOKEN}`,
    })
    expect(res.status).toBe(200)
  })

  it('refuses a bound session whose passkey was never admitted as a member', async () => {
    const fixture = await makeApp()
    await addGatingMember(fixture)
    const { token } = await bindSession(fixture)
    const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${token}`,
      Origin: HOSTED,
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'not_a_member' })
  })

  it('a bound member gets 200, offline tier, no leaseExpiresAt', async () => {
    const fixture = await makeApp()
    const { token, credentialId } = await bindSession(fixture)
    const addRes = await fixture.app.request(`/api/workspaces/${WS}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DAEMON_TOKEN}` },
      body: JSON.stringify({
        credentialId,
        origin: HOSTED,
        displayName: 'Ada Lovelace',
      } satisfies AddMemberRequest),
    })
    expect(addRes.status).toBe(201)

    const res = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${token}`,
      Origin: HOSTED,
    })
    expect(res.status).toBe(200)
    const body = replicaKeyResponseSchema.parse(await res.json())
    expect(body.tier).toBe('offline')
    expect(body.leaseExpiresAt).toBeUndefined()
  })

  it('revoke-then-read: L1 removal kills the bound token, and a fresh session for the same passkey is refused', async () => {
    const fixture = await makeApp()
    // A second, unrelated member keeps the workspace GATED after the first
    // is removed below — otherwise removing the only member reverts the
    // workspace to origin trust (S8) and the "fresh session refused"
    // assertion at the end would no longer hold.
    await addGatingMember(fixture)
    const { token, credentialId } = await bindSession(fixture)
    const addRes = await fixture.app.request(`/api/workspaces/${WS}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DAEMON_TOKEN}` },
      body: JSON.stringify({
        credentialId,
        origin: HOSTED,
        displayName: 'Ada Lovelace',
      } satisfies AddMemberRequest),
    })
    const member = memberProfileSummarySchema.parse(await addRes.json())

    const before = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${token}`,
      Origin: HOSTED,
    })
    expect(before.status).toBe(200)

    const delRes = await fixture.app.request(`/api/workspaces/${WS}/people/${member.profileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    })
    expect(delRes.status).toBe(200)

    // The killed session's token is now unknown to the daemon entirely —
    // the auth middleware answers 401 before the route is ever reached.
    const afterSameToken = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${token}`,
      Origin: HOSTED,
    })
    expect(afterSameToken.status).toBe(401)

    // A fresh session bound to the SAME passkey is refused as not-a-member,
    // rather than silently minting a new profile.
    const fresh = await bindSession(fixture)
    const afterFresh = await post(fixture.app, `/api/workspaces/${WS}/replica-key`, {
      Authorization: `Bearer ${fresh.token}`,
      Origin: HOSTED,
    })
    expect(afterFresh.status).toBe(403)
    expect((await afterFresh.json()) as { error: string }).toMatchObject({ error: 'not_a_member' })
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
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'unknown_workspace' })
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

  // The bar is `runtime:admin`, not member-scoped — a passkey-bound member
  // session (ALL_AUTH_SCOPES under the accepted v1 posture) still reaches
  // it, which is a narrower point than the macaroon test above and is noted
  // rather than asserted as a refusal: see routes/membership.ts's header.
  it('a passkey-bound member session (ALL_AUTH_SCOPES) also clears the bar, per the accepted v1 posture', async () => {
    const fixture = await makeApp()
    await seedWorkspaceRow(fixture)
    const { token } = await bindSession(fixture)
    const res = await put(
      fixture.app,
      `/api/workspaces/${WS}/replica-tier`,
      { tier: 'offline' },
      { Authorization: `Bearer ${token}`, Origin: HOSTED },
    )
    expect(res.status).toBe(200)
  })
})
