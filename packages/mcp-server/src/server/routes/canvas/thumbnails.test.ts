import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return '/tmp/test-thumbnails'
  },
  getDataDir: () => '/tmp/test-thumbnails',
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createThumbnailsRouter } = await import('./thumbnails.js')

describe('thumbnails router', () => {
  it('returns a Hono instance', () => {
    const versionStore = { listVersions: vi.fn(), saveVersion: vi.fn() }
    const app = createThumbnailsRouter({ versionStore: versionStore as never })
    expect(app).toBeInstanceOf(Hono)
  })
})
