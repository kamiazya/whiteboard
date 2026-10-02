import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimWorkspaceSegment } from './claim-workspace-segment.js'
import { createIsolatedDb, type IsolatedDbHandle } from './test-helpers.js'
import { upsertWorkspaceRow } from './upsert-workspace.js'

describe('claimWorkspaceSegment', () => {
  let dataDir: string
  let handle: IsolatedDbHandle

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'claim-workspace-segment-'))
    handle = await createIsolatedDb({ dataDir })
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })

  async function segments(): Promise<Record<string, string | null>> {
    const rows = await handle.db.selectFrom('workspaces').select(['id', 'segment']).execute()
    return Object.fromEntries(rows.map((row) => [row.id, row.segment]))
  }

  it('fills a workspace that has no segment', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-a')
    await expect(claimWorkspaceSegment(handle.db, 'ws-a', 'default')).resolves.toBe(true)
    expect(await segments()).toEqual({ 'ws-a': 'default' })
  })

  it('answers false and changes nothing the second time', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-a')
    await claimWorkspaceSegment(handle.db, 'ws-a', 'default')
    await expect(claimWorkspaceSegment(handle.db, 'ws-a', 'default')).resolves.toBe(false)
    expect(await segments()).toEqual({ 'ws-a': 'default' })
  })

  it('does not take the segment from the workspace that holds it', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-holder', { segment: 'default' })
    await upsertWorkspaceRow(handle.db, 'ws-a')
    await expect(claimWorkspaceSegment(handle.db, 'ws-a', 'default')).resolves.toBe(false)
    expect(await segments()).toEqual({ 'ws-holder': 'default', 'ws-a': null })
  })

  it('does not overwrite a segment the workspace already has', async () => {
    await upsertWorkspaceRow(handle.db, 'ws-a', { segment: 'mine' })
    await expect(claimWorkspaceSegment(handle.db, 'ws-a', 'default')).resolves.toBe(false)
    expect(await segments()).toEqual({ 'ws-a': 'mine' })
  })

  it('answers false for a workspace that is not registered', async () => {
    await expect(claimWorkspaceSegment(handle.db, 'ws-missing', 'default')).resolves.toBe(false)
    expect(await segments()).toEqual({})
  })
})
