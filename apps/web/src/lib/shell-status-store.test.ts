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

  // The browser keeper's whole health is its storage, so a publisher that
  // goes ok -> failed without passing through null (the store's contract, not
  // only what one page happens to do) must still reach the shell.
  it('a storage-health change under the browser keeper notifies and is stored', () => {
    setShellConnection({ state: { keeper: 'browser', storage: 'ok' } })
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellConnection({ state: { keeper: 'browser', storage: 'failed' } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getShellConnection()?.state).toEqual({ keeper: 'browser', storage: 'failed' })
  })

  it('re-publishing the same browser storage health does not notify', () => {
    setShellConnection({
      state: { keeper: 'browser', storage: 'failed' },
      lastWrittenAt: '2026-01-01T00:00:00.000Z',
    })
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellConnection({
      state: { keeper: 'browser', storage: 'failed' },
      lastWrittenAt: '2026-01-01T00:00:00.000Z',
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('a newer landed write under the browser keeper notifies, for the popover time', () => {
    setShellConnection({
      state: { keeper: 'browser', storage: 'ok' },
      lastWrittenAt: '2026-01-01T00:00:00.000Z',
    })
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellConnection({
      state: { keeper: 'browser', storage: 'ok' },
      lastWrittenAt: '2026-01-01T00:00:05.000Z',
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getShellConnection()?.lastWrittenAt).toBe('2026-01-01T00:00:05.000Z')
  })

  it('switching keeper under the same address notifies', () => {
    setShellConnection({ state: { keeper: 'browser', storage: 'ok' } })
    const listener = vi.fn()
    subscribeShellStatus(listener)
    setShellConnection({ state: { keeper: 'daemon', session: 'synced' } })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clearing a published connection notifies', () => {
    setShellConnection({ state: { keeper: 'browser', storage: 'ok' } })
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
