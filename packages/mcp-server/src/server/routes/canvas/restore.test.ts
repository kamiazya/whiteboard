import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return '/tmp/test-restore'
  },
  getDataDir: () => '/tmp/test-restore',
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createRestoreRouter } = await import('./restore.js')

describe('restore router', () => {
  it('returns a Hono instance', () => {
    const versionStore = { listVersions: vi.fn(), saveVersion: vi.fn() }
    const app = createRestoreRouter({ versionStore: versionStore as never })
    expect(app).toBeInstanceOf(Hono)
  })
})
