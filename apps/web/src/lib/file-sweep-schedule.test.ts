import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import type { BrowserFileSweepResult } from './browser-file-sweep.js'
import { scheduleFileSweep, sweepAfterPurge } from './file-sweep-schedule.js'

const swept: BrowserFileSweepResult = { kind: 'swept', deleted: [] }

describe('scheduleFileSweep', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs the sweep once, in the slot it is handed', async () => {
    vi.stubGlobal('indexedDB', {})
    const sweep = vi.fn(async () => swept)
    let slot: (() => void) | undefined
    scheduleFileSweep({ sweep, wait: (run) => (slot = run) })
    expect(sweep).not.toHaveBeenCalled()

    slot?.()

    expect(sweep).toHaveBeenCalledTimes(1)
  })

  it('schedules nothing where the browser keeps no IndexedDB', () => {
    vi.stubGlobal('indexedDB', undefined)
    const wait = vi.fn()
    scheduleFileSweep({ sweep: async () => swept, wait })
    expect(wait).not.toHaveBeenCalled()
  })
})

describe('sweepAfterPurge', () => {
  it('sweeps at once, against the database the purge wrote to', () => {
    const sweep = vi.fn(async (_dbName?: string) => swept)

    sweepAfterPurge('whiteboard-under-test', { sweep })

    expect(sweep).toHaveBeenCalledExactlyOnceWith('whiteboard-under-test')
  })

  it('reports a failed sweep rather than throwing into the purge', async () => {
    expect(() =>
      sweepAfterPurge(undefined, { sweep: async () => Promise.reject(new Error('idb closed')) }),
    ).not.toThrow()

    await expectLoggedFailure('file sweep after purge failed')
  })
})
