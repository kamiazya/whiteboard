import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getShellConnection,
  resetShellStatusForTests,
  setShellConnection,
  subscribeShellStatus,
} from './shell-status-store.js'

beforeEach(() => {
  resetShellStatusForTests()
})

describe('shell-status-store', () => {
  it('starts with no live session, so the shell has nothing to claim', () => {
    expect(getShellConnection()).toBeNull()
  })

  it('publishing a connection notifies subscribers', () => {
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellConnection({ state: 'synced', daemonBaseUrl: 'http://127.0.0.1:3099' })
    expect(getShellConnection()?.state).toBe('synced')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  // useSyncExternalStore reads a fresh object as a change, so an identity
  // comparison here would re-render the shell on every page render.
  it('re-publishing the same fields does not notify', () => {
    setShellConnection({ state: 'synced', daemonBaseUrl: 'http://127.0.0.1:3099' })
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellConnection({ state: 'synced', daemonBaseUrl: 'http://127.0.0.1:3099' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('clearing a published connection notifies', () => {
    setShellConnection({ state: 'local' })
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellConnection(null)
    expect(getShellConnection()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clearing when nothing was published does not notify', () => {
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellConnection(null)
    expect(listener).not.toHaveBeenCalled()
  })
})
