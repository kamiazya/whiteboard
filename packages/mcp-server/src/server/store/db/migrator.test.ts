import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

const { getDb, closeDb, clearDbCache } = await import('./index.js')
const { runMigrations } = await import('./migrator.js')

describe('runMigrations', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-db-migrator-test-'))
    clearDbCache()
  })

  afterEach(async () => {
    await closeDb(tempDir).catch(() => {})
    clearDbCache()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates the database file and applies every migration on a fresh data dir', async () => {
    const db = await getDb(tempDir)
    await runMigrations(db)
    // The libsql file backend should have created the .db file under DATA_DIR.
    await expect(stat(join(tempDir, 'whiteboard.db'))).resolves.toBeDefined()
    // Re-running is a no-op: kysely's __kysely_migration tracking table must
    // mark every migration as applied so the second call returns silently.
    await expect(runMigrations(db)).resolves.toBeUndefined()
  })

  it('imports a v0 workspace layout into the freshly migrated schema', async () => {
    const workspaceId = 'X9abcdefghijklmnopqrs' // 21 chars, nanoid-shaped
    const wsDir = join(tempDir, workspaceId)
    await mkdir(wsDir, { recursive: true })
    await writeFile(
      join(wsDir, '.names.json'),
      JSON.stringify({
        workspace: 'My Workspace',
        canvases: { foo: 'Foo Display' },
        pinned: ['foo'],
      }),
    )
    await writeFile(join(wsDir, 'foo.loro'), 'fake-loro-bytes-for-test')
    await writeFile(
      join(wsDir, 'palette.json'),
      JSON.stringify({ 'plan.bg': '#aabbcc' }),
    )
    await writeFile(
      join(tempDir, '.current-workspace'),
      workspaceId,
    )

    const db = await getDb(tempDir)
    await runMigrations(db)

    const wsRow = await db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', workspaceId)
      .executeTakeFirst()
    expect(wsRow?.displayName).toBe('My Workspace')

    const canvasRow = await db
      .selectFrom('canvases')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('slug', '=', 'foo')
      .executeTakeFirst()
    expect(canvasRow?.displayName).toBe('Foo Display')
    expect(canvasRow?.isPinned).toBe(1)
    expect(canvasRow?.pinOrder).toBe(0)

    const palette = await db
      .selectFrom('palette')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute()
    expect(palette).toEqual([
      expect.objectContaining({ key: 'plan.bg', value: '#aabbcc' }),
    ])

    const runtime = await db
      .selectFrom('runtime')
      .selectAll()
      .where('key', '=', 'currentWorkspaceId')
      .executeTakeFirst()
    expect(runtime?.value).toBe(workspaceId)

    // Blob files moved out of the workspace dir into blobs/.
    const movedLoro = await readFile(
      join(tempDir, 'blobs', workspaceId, 'canvas', 'foo.loro'),
      'utf-8',
    )
    expect(movedLoro).toBe('fake-loro-bytes-for-test')

    // Legacy metadata files quarantined under .legacy-bak/ instead of deleted.
    await expect(
      stat(join(tempDir, '.legacy-bak', 'v0-filesystem', workspaceId, '.names.json')),
    ).resolves.toBeDefined()
    await expect(
      stat(join(tempDir, '.legacy-bak', 'v0-filesystem', workspaceId, 'palette.json')),
    ).resolves.toBeDefined()
    await expect(
      stat(join(tempDir, '.legacy-bak', 'v0-filesystem', '_root', '.current-workspace')),
    ).resolves.toBeDefined()
  })

  it('skips non-nanoid directories under DATA_DIR (e.g. logs/) without inserting workspaces', async () => {
    await mkdir(join(tempDir, 'logs'), { recursive: true })
    await mkdir(join(tempDir, 'tmp'), { recursive: true })
    await mkdir(join(tempDir, 'something-arbitrary'), { recursive: true })

    const db = await getDb(tempDir)
    await runMigrations(db)

    const all = await db.selectFrom('workspaces').selectAll().execute()
    expect(all).toEqual([])
    // Non-nanoid dirs should still be on disk; the importer only touches
    // dirs whose name matches the 21-char nanoid pattern.
    await expect(stat(join(tempDir, 'logs'))).resolves.toBeDefined()
    await expect(stat(join(tempDir, 'tmp'))).resolves.toBeDefined()
    await expect(
      stat(join(tempDir, 'something-arbitrary')),
    ).resolves.toBeDefined()
  })

  it('is idempotent across repeated runs (no duplicate workspace rows or quarantine entries)', async () => {
    const workspaceId = 'aBcDeFgHiJkLmNoPqRsTu'
    await mkdir(join(tempDir, workspaceId), { recursive: true })
    await writeFile(join(tempDir, workspaceId, 'foo.loro'), 'x')

    const db = await getDb(tempDir)
    await runMigrations(db)
    await runMigrations(db)

    const workspaces = await db.selectFrom('workspaces').selectAll().execute()
    expect(workspaces).toHaveLength(1)
    const canvases = await db.selectFrom('canvases').selectAll().execute()
    expect(canvases).toHaveLength(1)
  })
})
