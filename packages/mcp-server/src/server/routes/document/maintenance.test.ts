import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return '/tmp/test-maintenance'
  },
  getDataDir: () => '/tmp/test-maintenance',
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createMaintenanceRouter } = await import('./maintenance.js')

describe('maintenance router', () => {
  it('returns a Hono instance', () => {
    const versionStore = { listVersions: vi.fn(), saveVersion: vi.fn() }
    const app = createMaintenanceRouter({ versionStore: versionStore as never })
    expect(app).toBeInstanceOf(Hono)
  })
})
