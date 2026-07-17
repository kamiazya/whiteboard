import { describe, expect, it, vi } from 'vitest'
import { isCliAvailable } from './cli-available.mjs'

describe('isCliAvailable', () => {
  it('returns false when spawnSync reports an ENOENT error', () => {
    const spawnSyncImpl = vi.fn().mockReturnValue({
      error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
      status: null,
    })

    expect(isCliAvailable('claude', spawnSyncImpl)).toBe(false)
    expect(spawnSyncImpl).toHaveBeenCalledWith('claude', ['--version'], { stdio: 'ignore' })
  })

  it('returns false when the CLI exits with a non-zero status', () => {
    const spawnSyncImpl = vi.fn().mockReturnValue({ error: undefined, status: 1 })

    expect(isCliAvailable('codex', spawnSyncImpl)).toBe(false)
  })

  it('returns true when the CLI exits successfully', () => {
    const spawnSyncImpl = vi.fn().mockReturnValue({ error: undefined, status: 0 })

    expect(isCliAvailable('claude', spawnSyncImpl)).toBe(true)
  })
})
