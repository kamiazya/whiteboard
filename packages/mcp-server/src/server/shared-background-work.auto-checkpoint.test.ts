import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckpointScheduler } from '@kamiazya/whiteboard-history'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { globalStoreScope } from './store/store-scope.js'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createSharedWorkers, sharedBackgroundWork, stdioBackgroundWork } = await import(
  './shared-background-work.js'
)
const { checkpointAfterWrite, uninstallAutoCheckpoint } = await import('./store/auto-checkpoint.js')
const { disposeAutoCompact } = await import('./store/auto-compact.js')

function fakeScheduler() {
  const signalled: string[] = []
  const flush = vi.fn(async () => undefined)
  const scheduler: CheckpointScheduler = Object.assign(
    (workspaceId: string, path: string) => {
      signalled.push(`${workspaceId}/${path}`)
    },
    { flush, stop: () => undefined },
  )
  return { scheduler, signalled, flush }
}

describe('the auto-checkpoint declaration both kinds of root arm', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wb-shared-checkpoint-'))
  })
  afterEach(async () => {
    uninstallAutoCheckpoint()
    await disposeAutoCompact()
    await rm(tempDir, { recursive: true, force: true })
  })

  function httpDeclaration(scheduler: () => CheckpointScheduler | undefined) {
    const declared = sharedBackgroundWork(createSharedWorkers('instance-a', globalStoreScope), {
      checkpointScheduler: scheduler,
      fileGc: { start: () => {}, stop: async () => {} },
    }).find((entry) => entry.name === 'auto-checkpoint')
    if (declared?.worker == null) throw new Error('the shared set declares no auto-checkpoint')
    return declared.worker
  }

  it('routes the agent write path to the router scheduler once started, and flushes it on stop', async () => {
    const { scheduler, signalled, flush } = fakeScheduler()
    const worker = httpDeclaration(() => scheduler)

    checkpointAfterWrite('ws-1', 'before-start', new LoroDoc())
    expect(signalled).toEqual([])

    worker.start()
    checkpointAfterWrite('ws-1', 'after-start', new LoroDoc())
    expect(signalled).toEqual(['ws-1/after-start'])

    await worker.stop()
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('starts and stops without a scheduler when the router has not handed one back', async () => {
    const worker = httpDeclaration(() => undefined)
    worker.start()
    await expect(worker.stop()).resolves.toBeUndefined()
  })

  it('is declared by the stdio set as well, beside the compaction it waits out', async () => {
    const declared = stdioBackgroundWork(globalStoreScope)
    expect(declared.map((entry) => entry.name)).toEqual(['auto-checkpoint', 'auto-compact'])
    expect(declared.every((entry) => entry.worker !== null)).toBe(true)
  })
})
