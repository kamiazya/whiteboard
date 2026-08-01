import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return '/tmp/test-live-doc'
  },
  getDataDir: () => '/tmp/test-live-doc',
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createLiveDocRouter } = await import('./live-doc.js')

describe('live-doc router', () => {
  it('returns a Hono instance', () => {
    const triggerAutoVersion = vi.fn()
    const app = createLiveDocRouter({ triggerAutoVersion })
    expect(app).toBeInstanceOf(Hono)
  })
})
