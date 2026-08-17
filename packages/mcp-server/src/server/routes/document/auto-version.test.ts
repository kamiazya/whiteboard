import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return '/tmp/test-auto-version'
  },
  getDataDir: () => '/tmp/test-auto-version',
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { AUTO_VERSION_INTERVAL_MS, createAutoVersionTrigger } = await import('./auto-version.js')

describe('auto-version', () => {
  it('exports a positive interval constant', () => {
    expect(AUTO_VERSION_INTERVAL_MS).toBeGreaterThan(0)
  })

  it('createAutoVersionTrigger is a function', () => {
    expect(typeof createAutoVersionTrigger).toBe('function')
  })
})
