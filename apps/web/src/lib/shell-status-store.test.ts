import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getShellDaemonAuthError,
  resetShellStatusForTests,
  setShellDaemonAuthError,
  subscribeShellStatus,
} from './shell-status-store.js'

beforeEach(() => {
  resetShellStatusForTests()
})

describe('shell-status-store', () => {
  it('starts without an auth error', () => {
    expect(getShellDaemonAuthError()).toBe(false)
  })

  it('setting the auth error notifies subscribers', () => {
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellDaemonAuthError(true)
    expect(getShellDaemonAuthError()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('setting the same value does not notify', () => {
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellDaemonAuthError(false)
    expect(listener).not.toHaveBeenCalled()
  })
})
