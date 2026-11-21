/**
 * The shared background work serves the dir it is handed, not the process's.
 *
 * `createSharedWorkers(instanceId, scope)` is built from the `StoreScope` a
 * root booted its deps over. The workers used to reach the process's
 * `getDataDir()` underneath — the backup scheduler copied it, the lease was
 * taken in its database, the sweeper swept it and auto-compaction folded its
 * record — so on a keeper serving another directory the routes and the deps
 * were right and every scheduled thing quietly worked on a different tree.
 * The backup is the one that matters: it would have reported success over the
 * wrong data.
 *
 * Both dirs are seeded, so a worker that follows the global works on a real
 * directory and answers with the wrong contents rather than failing loudly.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ServerDeps, wbDocumentCreate } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootSelfHostDeps } from '../di/boot-self-host-deps.js'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import type { BackgroundWork } from './background-work.js'
import { captureLogsForTests } from './log.js'
import { documentOf } from './routes/_test-helpers.js'
import {
  createSharedWorkers,
  type SharedWorkerFactories,
  sharedBackgroundWork,
} from './shared-background-work.js'
import { disposeAutoCompact, uninstallAutoCompact } from './store/auto-compact.js'
import { type BackupSchedulerOptions, createBackupScheduler } from './store/backup-scheduler.js'
import { clearDbCacheForTests, closeDb, getDb } from './store/db/index.js'
import { createFileGcSweeper, type FileGcSweeper } from './store/file-gc-sweeper.js'
import { globalStoreScope } from './store/store-scope.js'
import {
  _clearWorkspaceDocCacheForTests,
  withStoredWorkspaceRecord,
} from './store/workspace-doc-cache.js'

const WS = '01ZVM89A4A1V9FS03Z9J64KEK1'
const SERVED_ONLY = 'only-in-served'

let served: string
let ambient: string

beforeEach(async () => {
  served = await mkdtemp(join(tmpdir(), 'wb-served-'))
  ambient = await mkdtemp(join(tmpdir(), 'wb-ambient-'))
  setDataDirForTests(ambient)
  vi.stubEnv('WHITEBOARD_FILE_GC_GRACE_MS', '0')
})

afterEach(async () => {
  vi.useRealTimers()
  uninstallAutoCompact()
  await disposeAutoCompact()
  _clearWorkspaceDocCacheForTests()
  await closeDb(served)
  await closeDb(ambient)
  clearDbCacheForTests()
  resetDataDirForTests()
  vi.unstubAllEnvs()
  await rm(served, { recursive: true, force: true })
  await rm(ambient, { recursive: true, force: true })
})

async function seed(deps: ServerDeps, paths: readonly string[]): Promise<void> {
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  for (const path of paths) {
    await wbDocumentCreate(deps, { workspaceId: WS, path, kind: 'spatial' })
  }
}

/** Two keepers; the process global names `ambient`, the workers are given `served`. */
async function bootBoth() {
  const other = await bootSelfHostDeps(ambient)
  await seed(other.serverDeps, ['note'])
  const boot = await bootSelfHostDeps(served)
  await seed(boot.serverDeps, ['note', SERVED_ONLY])
  return { boot, other }
}

function declared(work: readonly BackgroundWork[], name: string): BackgroundWork {
  const found = work.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`the shared set declares no ${name} worker`)
  return found
}

const NO_FILE_GC = { start: () => {}, stop: async () => {} }

describe('the shared workers over a dir the process global does not name', () => {
  it('hands the backup scheduler the served dir, and takes its lease in the served database', async () => {
    const { boot } = await bootBoth()
    let captured: BackupSchedulerOptions | undefined
    const backupSchedulerFactory: SharedWorkerFactories['backupSchedulerFactory'] = (options) => {
      captured = options
      return createBackupScheduler({ ...options, backupDir: null })
    }
    createSharedWorkers('instance-a', boot.scope, { backupSchedulerFactory })

    expect(captured?.dataDir).toBe(served)

    let leasesInServed: string[] = []
    let leasesInAmbient: string[] = []
    const outcome = await captured?.runExclusively?.(async () => {
      // While the pass runs: the row is held, and it is held in ONE database.
      const rows = (db: Awaited<ReturnType<typeof getDb>>) =>
        db.selectFrom('leases').select('name').execute()
      leasesInServed = (await rows(await getDb(served))).map((row) => row.name)
      leasesInAmbient = (await rows(await getDb(ambient))).map((row) => row.name)
    })
    expect(outcome?.ok).toBe(true)
    expect(leasesInServed).toEqual(['backup'])
    expect(leasesInAmbient).toEqual([])
  })

  it('sweeps the served workspace files, not the ambient ones', async () => {
    const { boot } = await bootBoth()
    let sweeper: FileGcSweeper | undefined
    createSharedWorkers('instance-a', boot.scope, {
      fileGcSweeperFactory: (options) => {
        sweeper = createFileGcSweeper({ ...options, intervalMs: 0 })
        return sweeper
      },
    })
    const dangling = boot.scope.layout.workspaceFilesDir(WS)
    await mkdir(dangling, { recursive: true })
    await writeFile(join(dangling, 'dangling.png'), 'x')

    await sweeper?.tick()

    expect(await readdir(dangling)).toEqual([])
  })

  it('folds the served workspace record once a save has been quiet', async () => {
    const { boot } = await bootBoth()
    const doc = await documentOf(boot.serverDeps, WS, 'note')
    // A version is what makes the record worth folding. The ambient dir holds
    // none, so a fold of THAT record declines `no-versions`.
    await boot.serverDeps.versions.save(WS, 'note', { auto: false })
    const logs = captureLogsForTests('info')
    try {
      const work = declared(
        sharedBackgroundWork(createSharedWorkers('instance-a', boot.scope), {
          checkpointScheduler: () => undefined,
          fileGc: NO_FILE_GC,
        }),
        'auto-compact',
      )
      work.worker?.start()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await boot.serverDeps.liveDocuments.create(WS, 'note', doc.export({ mode: 'snapshot' }), {
        overwrite: true,
      })
      await vi.advanceTimersByTimeAsync(31_000)
      vi.useRealTimers()
      await work.worker?.stop()

      const outcomes = logs.records.filter((record) => record.scope === 'auto-compact')
      expect(outcomes.map((record) => record.msg)).toEqual([
        expect.stringMatching(/compacted|declined/),
      ])
      expect(outcomes[0]?.data).not.toMatchObject({ reason: 'no-versions' })
    } finally {
      logs.restore()
    }
  })

  it('tails the served workspace record', async () => {
    const { boot } = await bootBoth()
    vi.stubEnv('WHITEBOARD_WORKSPACE_TAIL_MS', '1000')
    let docs: Parameters<NonNullable<SharedWorkerFactories['workspaceTailFactory']>>[0] | undefined
    createSharedWorkers('instance-a', boot.scope, {
      workspaceTailFactory: (options) => {
        docs = options
        return { start: () => {}, stop: async () => {}, pollOnce: async () => {} }
      },
    })

    // Follows the record of the served directory.
    const followed = await docs?.follow(WS, undefined)
    expect(followed?.cursor).toBeDefined()
    expect(
      await withStoredWorkspaceRecord(WS, boot.scope, async (record) =>
        record === null
          ? []
          : (
              await record.read(
                { query: 'documents' },
                { parse: (value) => value as { path: string }[] },
              )
            ).map((entry) => entry.path),
      ),
    ).toContain(SERVED_ONLY)
    // Present in one record only, so a tail over the other cannot follow it without minting.
    const SERVED_ONLY_WORKSPACE_ID = '0167ZVW5JTK6PNPG242QD3F8DE'
    await boot.serverDeps.documentIndex.createWorkspace({ workspaceId: SERVED_ONLY_WORKSPACE_ID })
    expect(await docs?.follow(SERVED_ONLY_WORKSPACE_ID, undefined)).toBeDefined()
    expect(
      await withStoredWorkspaceRecord(SERVED_ONLY_WORKSPACE_ID, globalStoreScope, async (r) => r),
    ).toBeNull()
  })
})
