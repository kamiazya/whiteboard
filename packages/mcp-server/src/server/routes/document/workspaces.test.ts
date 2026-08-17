import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return '/tmp/test-workspaces'
  },
  getDataDir: () => '/tmp/test-workspaces',
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createWorkspacesRouter } = await import('./workspaces.js')

describe('workspaces router', () => {
  it('returns a Hono instance', () => {
    const app = createWorkspacesRouter()
    expect(app).toBeInstanceOf(Hono)
  })
})
