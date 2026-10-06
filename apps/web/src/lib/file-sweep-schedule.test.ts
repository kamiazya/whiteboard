import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserFileSweepResult } from './browser-file-sweep.js'
import { scheduleFileSweep } from './file-sweep-schedule.js'

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
