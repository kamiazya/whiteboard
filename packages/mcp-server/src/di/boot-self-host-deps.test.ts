/**
 * `bootSelfHostDeps(dataDir)` serves THAT data dir, whatever the process's
 * `getDataDir()` answers.
 *
 * It builds the document store, the blob store and the index over the dir it
 * is handed, and every seam beside them — live documents, versions, teardown,
 * the write signal — has to follow the same dir. Those seams used to read the
 * process global underneath, so the two halves agreed only while the global
 * happened to equal the argument. All three roots pass it, so nothing broke;
 * a second data dir (a second tenant's keeper, an isolated harness) would have
 * split silently, with documents under one directory and their versions,
 * blobs and cache under another.
 *
 * Asserted by what is LEFT in the global dir: opening a database or writing a
 * blob there is the leak, and an empty directory is the one thing a leak
 * cannot satisfy.
 */
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wbDocumentCreate, wbDocumentDelete } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disposeAutoCompact, uninstallAutoCompact } from '../server/store/auto-compact.js'
import { clearDbCacheForTests, closeDb, getDb } from '../server/store/db/index.js'
import { clearDocCacheForTests } from '../server/store/doc-cache.js'
import { purgeDanglingFiles } from '../server/store/file-gc.js'
import { createFileGcSweeper } from '../server/store/file-gc-sweeper.js'
import { loadWorkspaceNames, setWorkspaceName } from '../server/store/names-store.js'
import { storeScope } from '../server/store/store-scope.js'
import { _clearWorkspaceDocCacheForTests } from '../server/store/workspace-doc-cache.js'
import { SELF_HOST_TENANT_ID } from '../server/tenant/id.js'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import { bootSelfHostDeps } from './boot-self-host-deps.js'

let served: string
let ambient: string

beforeEach(async () => {
  served = await mkdtemp(join(tmpdir(), 'wb-served-'))
  ambient = await mkdtemp(join(tmpdir(), 'wb-ambient-'))
  setDataDirForTests(ambient)
})

afterEach(async () => {
  uninstallAutoCompact()
  await disposeAutoCompact()
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await closeDb(served)
  clearDbCacheForTests()
  resetDataDirForTests()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(served, { recursive: true, force: true })
  await rm(ambient, { recursive: true, force: true })
})

describe('bootSelfHostDeps over a dir the process global does not name', () => {
  it('writes documents, versions, blobs and teardown only under the dir it was given', async () => {
    const { serverDeps: deps } = await bootSelfHostDeps(served)
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'note',
      kind: 'spatial',
    })

    const doc = await deps.liveDocuments.get('ws-1', 'note')
    await deps.liveDocuments.save('ws-1', 'note', doc, { overwrite: true })
    const version = await deps.versions.save('ws-1', 'note', doc, { auto: false })
    const { ref } = await deps.blobStore.put({ bytes: new Uint8Array([1, 2, 3]) })

    expect((await deps.documentIndex.listWorkspaces()).map((entry) => entry.workspaceId)).toContain(
      'ws-1',
    )
    await deps.documentIndex.renameWorkspace({ workspaceId: 'ws-1', displayName: 'Served' })
    expect(await deps.workspaceDocuments.exists('ws-1')).toBe(true)
    await deps.workspaceDocuments.save('ws-1', await deps.workspaceDocuments.get('ws-1'))
    expect((await deps.liveDocuments.list('ws-1')).map((entry) => entry.path)).toEqual(['note'])
    expect((await deps.versions.list('ws-1', 'note')).map((entry) => entry.id)).toEqual([
      version.id,
    ])
    expect((await deps.blobStore.has({ ref })).exists).toBe(true)

    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: created.documentId })
    expect(await deps.liveDocuments.exists('ws-1', 'note')).toBe(false)

    expect(await readdir(ambient)).toEqual([])
    // Where the live store put it, spelled out rather than asked of the layout:
    // the delete above also evacuated the document into the trash as a blob.
    const { digestHex } = ref
    await expect(
      stat(
        join(
          served,
          'tenants',
          SELF_HOST_TENANT_ID,
          'blobs',
          digestHex.slice(0, 2),
          digestHex.slice(2),
        ),
      ),
    ).resolves.toBeDefined()
  })

  it('keeps versions and the workspace record in the served dir database, not the global one', async () => {
    const { db, serverDeps: deps } = await bootSelfHostDeps(served)
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    await wbDocumentCreate(deps, { workspaceId: 'ws-1', path: 'note', kind: 'spatial' })
    await deps.versions.save('ws-1', 'note', new LoroDoc(), { auto: false })

    expect(await db.selectFrom('versions').select('id').execute()).toHaveLength(1)
    expect(
      (await db.selectFrom('workspaces').select('id').execute()).map((row) => row.id),
    ).toContain('ws-1')
    expect(await readdir(ambient)).toEqual([])
    // The same handle the global would have answered, were it consulted.
    expect(await getDb(served)).toBe(db)
  })

  it('schedules the write signal against the served dir', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { serverDeps: deps } = await bootSelfHostDeps(served)
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'note',
      kind: 'spatial',
    })

    await deps.documentWritten?.({
      workspaceId: 'ws-1',
      documentId: created.documentId,
      doc: new LoroDoc(),
    })
    // The debounce elapses and the compaction runs: with no versions it
    // declines, having read the workspace record and the versions table.
    await vi.advanceTimersByTimeAsync(31_000)
    vi.useRealTimers()
    await disposeAutoCompact()

    expect(await readdir(ambient)).toEqual([])
  })

  it('names and file GC, handed the same scope, stay in the served dir too', async () => {
    const { serverDeps: deps } = await bootSelfHostDeps(served)
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    await wbDocumentCreate(deps, { workspaceId: 'ws-1', path: 'note', kind: 'spatial' })
    const scope = storeScope(served)

    await setWorkspaceName('ws-1', 'Served', scope)
    expect((await loadWorkspaceNames('ws-1', scope)).workspace).toBe('Served')

    const files = scope.layout.workspaceFilesDir('ws-1')
    await mkdir(files, { recursive: true })
    await writeFile(join(files, 'dangling.png'), 'x')
    const purged = await purgeDanglingFiles('ws-1', { scope, graceMs: 0 })

    expect(purged.purgedCount).toBe(1)
    expect(await readdir(files)).toEqual([])
    expect(await readdir(ambient)).toEqual([])
  })

  it('the file sweep, handed the scope, finds and cleans the served dir', async () => {
    vi.stubEnv('WHITEBOARD_FILE_GC_GRACE_MS', '0')
    const { serverDeps: deps } = await bootSelfHostDeps(served)
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const scope = storeScope(served)
    // One workspace the registry knows and one only the disk does, so each
    // way the sweep finds work has to follow the scope on its own.
    const registered = scope.layout.workspaceFilesDir('ws-1')
    const onDisk = scope.layout.workspaceFilesDir('ws-disk')
    for (const dir of [registered, onDisk]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'dangling.png'), 'x')
    }

    await createFileGcSweeper({ intervalMs: 0, scope }).tick()

    expect(await readdir(registered)).toEqual([])
    expect(await readdir(onDisk)).toEqual([])
    expect(await readdir(ambient)).toEqual([])
  })

  it('finds a registered workspace through the scope when the disk walk finds none', async () => {
    vi.stubEnv('WHITEBOARD_FILE_GC_GRACE_MS', '0')
    const { serverDeps: deps } = await bootSelfHostDeps(served)
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const scope = storeScope(served)
    const files = scope.layout.workspaceFilesDir('ws-1')
    await mkdir(files, { recursive: true })
    await writeFile(join(files, 'dangling.png'), 'x')

    await createFileGcSweeper({
      intervalMs: 0,
      scope,
      discoverFsWorkspaces: async () => [],
    }).tick()

    expect(await readdir(files)).toEqual([])
    expect(await readdir(ambient)).toEqual([])
  })

  it('the file sweep judges containment against the served dir, not the process one', async () => {
    vi.stubEnv('WHITEBOARD_FILE_GC_GRACE_MS', '0')
    const { serverDeps: deps } = await bootSelfHostDeps(served)
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const scope = storeScope(served)
    // A workspace whose files/ is a symlink out of the data dir: the sweep
    // must refuse it. Judged against the process dir this path does not exist
    // at all, which reads as "nothing to refuse".
    const outside = await mkdtemp(join(tmpdir(), 'wb-outside-'))
    await writeFile(join(outside, 'dangling.png'), 'x')
    const files = scope.layout.workspaceFilesDir('ws-1')
    await mkdir(join(files, '..'), { recursive: true })
    await symlink(outside, files)

    await createFileGcSweeper({ intervalMs: 0, scope, discoverFsWorkspaces: async () => [] }).tick()

    expect(await readdir(outside)).toEqual(['dangling.png'])
    await rm(outside, { recursive: true, force: true })
  })
})
