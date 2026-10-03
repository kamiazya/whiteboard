/**
 * What a root takes from the shared set instead of writing itself: the file-GC
 * sweeper as a worker (with its capped stop) and the holder for the checkpoint
 * scheduler `createApp` hands back. Both roots used to hand-copy each, and a
 * copy that dropped the cap or never captured the scheduler failed nothing.
 */
import type { CheckpointScheduler } from '@kamiazya/whiteboard-history'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return '/tmp/wb-shared-roots-unused'
  },
  getDataDir: () => '/tmp/wb-shared-roots-unused',
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

import { FILE_GC_STOP_TIMEOUT_MS } from '../shared/stop-timeouts.js'
import { createSharedWorkers, sharedBackgroundWork } from './shared-background-work.js'
import { checkpointAfterWrite, uninstallAutoCheckpointForTests } from './store/auto-checkpoint.js'
import type { FileGcSweeper } from './store/file-gc-sweeper.js'
import { globalStoreScope } from './store/store-scope.js'

function fakeSweeper() {
  const sweeper = {
    start: vi.fn(),
    tick: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } satisfies FileGcSweeper
  return sweeper
}

function fakeScheduler() {
  const signalled: string[] = []
  const flush = vi.fn(async () => undefined)
  const scheduler: CheckpointScheduler = Object.assign(
    (workspaceId: string, path: string) => {
      signalled.push(`${workspaceId}/${path}`)
    },
    { flush, stop: () => undefined, moved: () => undefined, removed: () => undefined },
  )
  return { scheduler, signalled, flush }
}

afterEach(() => uninstallAutoCheckpointForTests())

describe('the file-GC worker the shared set builds', () => {
  it('starts the sweeper and stops it with the shutdown cap, never its default', async () => {
    const sweeper = fakeSweeper()
    const { fileGc } = createSharedWorkers('instance-a', globalStoreScope, {
      fileGcSweeperFactory: () => sweeper,
    })

    fileGc.start()
    expect(sweeper.start).toHaveBeenCalledTimes(1)

    await fileGc.stop()
    expect(sweeper.stop).toHaveBeenCalledWith({ timeoutMs: FILE_GC_STOP_TIMEOUT_MS })
    expect(FILE_GC_STOP_TIMEOUT_MS).toBe(5_000)
  })

  it('is the worker the file-gc-sweeper declaration arms, when a root passes no arming of its own', () => {
    const shared = createSharedWorkers('instance-a', globalStoreScope, {
      fileGcSweeperFactory: fakeSweeper,
    })
    const declared = sharedBackgroundWork(shared).find((w) => w.name === 'file-gc-sweeper')
    expect(declared?.worker).toBe(shared.fileGc)
  })
})

describe('the checkpoint holder the shared set builds', () => {
  it('takes no checkpoints, and flushes nothing, until createApp has handed a scheduler back', async () => {
    const { checkpoints } = createSharedWorkers('instance-a', globalStoreScope)
    expect(checkpoints.scheduler()).toBeUndefined()
    await expect(checkpoints.flush()).resolves.toBeUndefined()
  })

  it('flushes the scheduler it captured', async () => {
    const { checkpoints } = createSharedWorkers('instance-a', globalStoreScope)
    const { scheduler, flush } = fakeScheduler()

    checkpoints.capture(scheduler)

    expect(checkpoints.scheduler()).toBe(scheduler)
    await checkpoints.flush()
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('is what the auto-checkpoint declaration signals and flushes, with no arming passed', async () => {
    const shared = createSharedWorkers('instance-a', globalStoreScope)
    const worker = sharedBackgroundWork(shared).find((w) => w.name === 'auto-checkpoint')?.worker
    if (worker == null) throw new Error('the shared set declares no auto-checkpoint worker')
    const { scheduler, signalled, flush } = fakeScheduler()

    // createApp runs after the declarations are built, and before they start.
    shared.checkpoints.capture(scheduler)
    worker.start()
    checkpointAfterWrite('ws-1', 'a-document', new LoroDoc())
    expect(signalled).toEqual(['ws-1/a-document'])

    await worker.stop()
    expect(flush).toHaveBeenCalledTimes(1)
  })
})
