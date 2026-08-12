import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyUpdate,
  bindApplyUpdate,
  bindCheckForUpdates,
  checkForUpdates,
  getSwStatus,
  resetSwStatusForTests,
  subscribeSwStatus,
} from './sw-status-store.js'

beforeEach(() => {
  resetSwStatusForTests()
})

describe('sw-status-store', () => {
  it('starts unsupported with no update ready', () => {
    expect(getSwStatus()).toEqual({ supported: false, updateReady: false, checking: false })
  })

  it('binding a check handler marks the store supported and notifies', () => {
    const listener = vi.fn()
    subscribeSwStatus(listener)
    bindCheckForUpdates(async () => {})
    expect(getSwStatus().supported).toBe(true)
    expect(listener).toHaveBeenCalled()
  })

  it('checkForUpdates flips checking on and back off around the handler', async () => {
    const seen: boolean[] = []
    let resolve!: () => void
    bindCheckForUpdates(
      () =>
        new Promise<void>((r) => {
          resolve = r
        }),
    )
    subscribeSwStatus(() => seen.push(getSwStatus().checking))
    const done = checkForUpdates()
    expect(getSwStatus().checking).toBe(true)
    resolve()
    await done
    expect(getSwStatus().checking).toBe(false)
    expect(seen).toContain(true)
  })

  it('checking returns to false even when the handler rejects', async () => {
    bindCheckForUpdates(() => Promise.reject(new Error('offline')))
    await checkForUpdates()
    expect(getSwStatus().checking).toBe(false)
  })

  it('bindApplyUpdate marks an update ready; applyUpdate calls the handler', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    bindApplyUpdate(apply)
    expect(getSwStatus().updateReady).toBe(true)
    await applyUpdate()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('applyUpdate and checkForUpdates are safe no-ops before binding', async () => {
    await expect(applyUpdate()).resolves.toBeUndefined()
    await expect(checkForUpdates()).resolves.toBeUndefined()
  })

  it('getSnapshot identity is stable between notifications (useSyncExternalStore contract)', () => {
    const a = getSwStatus()
    const b = getSwStatus()
    expect(a).toBe(b)
    bindCheckForUpdates(async () => {})
    expect(getSwStatus()).not.toBe(a)
  })
})
