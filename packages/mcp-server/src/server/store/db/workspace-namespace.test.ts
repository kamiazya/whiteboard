/**
 * ADR-0053 at the registry's own writes: a segment is unique per
 * (tenant, namespace), so the same segment may sit in two namespaces and in
 * two tenants, and only a second claim INSIDE one namespace is refused.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWorkspaceSegmentTakenError } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SELF_HOST_TENANT_ID } from '../../tenant/id.js'
import { tenantDatabase } from './tenant-database.js'
import { createIsolatedDb } from './test-helpers.js'
import { renameWorkspaceRow, upsertWorkspaceRow } from './upsert-workspace.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-workspace-namespace-'))
  handle = await createIsolatedDb({ dataDir: root })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('a segment is unique within its namespace', () => {
  it('lets two namespaces each hold the same segment', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-ada', { segment: 'design', namespace: 'ada' })
    await upsertWorkspaceRow(handle.db, 'ws-bob', { segment: 'design', namespace: 'bob' })

    const rows = await handle.db
      .selectFrom('workspaces')
      .select(['id', 'namespace', 'segment'])
      .orderBy('id')
      .execute()
    expect(rows).toEqual([
      { id: 'ws-ada', namespace: 'ada', segment: 'design' },
      { id: 'ws-bob', namespace: 'bob', segment: 'design' },
    ])
  })

  it('refuses a second claim inside one namespace, naming that namespace', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-1', { segment: 'design', namespace: 'ada' })

    const refused = await upsertWorkspaceRow(handle.db, 'ws-2', {
      segment: 'design',
      namespace: 'ada',
    }).catch((err: unknown) => err)

    expect(isWorkspaceSegmentTakenError(refused)).toBe(true)
    expect((refused as Error).message).toBe(
      'Workspace segment "design" is already taken in namespace "ada"',
    )
  })

  it('keeps the single-person keeper on `me`, unnamed in the refusal', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-1', { segment: 'design' })

    const refused = await upsertWorkspaceRow(handle.db, 'ws-2', { segment: 'design' }).catch(
      (err: unknown) => err,
    )

    expect((refused as Error).message).toBe('Workspace segment "design" is already taken')
    const row = await handle.db
      .selectFrom('workspaces')
      .select('namespace')
      .where('id', '=', 'ws-1')
      .executeTakeFirstOrThrow()
    expect(row.namespace).toBe('me')
  })

  it('renames into a segment another namespace holds', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-ada', { segment: 'design', namespace: 'ada' })
    await upsertWorkspaceRow(handle.db, 'ws-bob', { segment: 'plans', namespace: 'bob' })

    expect(await renameWorkspaceRow(handle.db, 'ws-bob', { segment: 'design' })).toEqual({
      namespace: 'bob',
      segment: 'design',
      displayName: null,
    })
  })

  it('refuses a rename into a segment its own namespace holds', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-1', { segment: 'design', namespace: 'ada' })
    await upsertWorkspaceRow(handle.db, 'ws-2', { segment: 'plans', namespace: 'ada' })

    const refused = await renameWorkspaceRow(handle.db, 'ws-2', { segment: 'design' }).catch(
      (err: unknown) => err,
    )

    expect(isWorkspaceSegmentTakenError(refused)).toBe(true)
  })

  it('lets two tenants each hold the same segment in the same namespace', async () => {
    const other = tenantDatabase(handle.rawDb, 'tenant-two')
    const selfHost = tenantDatabase(handle.rawDb, SELF_HOST_TENANT_ID)
    await upsertWorkspaceRow(selfHost, 'ws-a', { segment: 'design', namespace: 'ada' })
    await upsertWorkspaceRow(other, 'ws-b', { segment: 'design', namespace: 'ada' })

    expect(await other.selectFrom('workspaces').select('id').execute()).toEqual([{ id: 'ws-b' }])
  })
})
