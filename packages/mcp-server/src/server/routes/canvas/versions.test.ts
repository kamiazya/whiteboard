import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return '/tmp/test-versions'
  },
  getDataDir: () => '/tmp/test-versions',
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createVersionsRouter } = await import('./versions.js')

describe('versions router', () => {
  it('returns a Hono instance', () => {
    const versionStore = { listVersions: vi.fn(), saveVersion: vi.fn() }
    const app = createVersionsRouter({ versionStore: versionStore as never })
    expect(app).toBeInstanceOf(Hono)
  })
})
