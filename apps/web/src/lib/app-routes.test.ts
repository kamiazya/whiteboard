import { describe, expect, it } from 'vitest'
import {
  browserLocalCanvasPath,
  browserLocalIndexPath,
  canvasPath,
  indexPath,
  workspacePath,
} from './app-routes.js'

describe('app-routes', () => {
  it('builds the index path', () => {
    expect(indexPath()).toBe('/')
  })

  it('builds a workspace-scoped index path', () => {
    expect(workspacePath('w1')).toBe('/w/w1')
  })

  it('builds a canvas path', () => {
    expect(canvasPath('w1', 'main')).toBe('/canvas/w1/main')
  })

  it('percent-encodes workspaceId and slug segments', () => {
    expect(canvasPath('w 1', 'my/slug')).toBe('/canvas/w%201/my%2Fslug')
    expect(workspacePath('w/1')).toBe('/w/w%2F1')
  })

  it('builds browser-local paths', () => {
    expect(browserLocalIndexPath()).toBe('/local')
    expect(browserLocalCanvasPath('abc-123')).toBe('/local/abc-123')
  })
})
