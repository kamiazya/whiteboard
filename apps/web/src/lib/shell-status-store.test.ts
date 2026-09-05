// @vitest-environment node
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
    setShellConnection({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'synced' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  // useSyncExternalStore reads a fresh object as a change, so an identity
  // comparison here would re-render the shell on every page render. The state
  // is an object now, so the comparison has to reach INTO it — a fresh but
  // equal literal is exactly what a render-scoped effect republishes.
  it('re-publishing the same fields does not notify', () => {
    setShellConnection({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellConnection({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('a session-health change under the same keeper notifies', () => {
    setShellConnection({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellConnection({
      state: { keeper: 'daemon', session: 'reconnecting' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'reconnecting' })
  })

  it('clearing a published connection notifies', () => {
    setShellConnection({ state: { keeper: 'browser' } })
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
