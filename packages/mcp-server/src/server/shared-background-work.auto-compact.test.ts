import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createSharedWorkers, sharedBackgroundWork } = await import('./shared-background-work.js')
const { saveDocument } = await import('./store/document-store.js')
const { _autoCompactTimerCountForTests, disposeAutoCompact } = await import(
  './store/auto-compact.js'
)

// Subscribing to saves is what makes the HTTP write path debounce a fold, and
// it used to happen as a side effect of constructing a router. Declared in the
// shared set it is armed and stopped by the registry like every other worker.
describe('the shared set arms auto-compaction', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wb-shared-compact-'))
  })
  afterEach(async () => {
    await disposeAutoCompact()
    await rm(tempDir, { recursive: true, force: true })
  })

  function declared() {
    const work = sharedBackgroundWork(createSharedWorkers('instance-a'), {
      checkpointScheduler: () => undefined,
      fileGc: { start: () => {}, stop: async () => {} },
    }).find((entry) => entry.name === 'auto-compact')
    if (work === undefined) throw new Error('the shared set declares no auto-compact worker')
    return work
  }

  it('debounces a fold for a save once started, and for none once stopped', async () => {
    const worker = declared().worker
    if (worker === null) throw new Error('auto-compact declares no worker')

    expect(_autoCompactTimerCountForTests()).toBe(0)
    await saveDocument('ws-1', 'before-start', new LoroDoc())
    expect(_autoCompactTimerCountForTests()).toBe(0)

    worker.start()
    await saveDocument('ws-1', 'after-start', new LoroDoc())
    expect(_autoCompactTimerCountForTests()).toBe(1)

    await worker.stop()
    expect(_autoCompactTimerCountForTests()).toBe(0)
    await saveDocument('ws-1', 'after-stop', new LoroDoc())
    expect(_autoCompactTimerCountForTests()).toBe(0)
  })
})
