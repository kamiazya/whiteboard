import { describe, expect, it } from 'vitest'
import {
  browserLocalCanvasPath,
  browserLocalIndexPath,
  canvasPath,
  daemonRoutePath,
  indexPath,
  isKnownAppPath,
  parseBrowserLocalRoute,
  parseDaemonRoute,
  parseSettingsRoute,
  settingsPath,
  workspacePath,
} from './app-routes.js'

describe('app-routes', () => {
  it('builds the index path', () => {
    expect(indexPath()).toBe('/')
  })

  it('builds a workspace-scoped index path', () => {
    expect(workspacePath('w1')).toBe('/w/w1')
  })

  it('builds a canvas path under the workspace it belongs to', () => {
    expect(canvasPath('w1', 'main')).toBe('/w/w1/canvas/main')
  })

  it('percent-encodes the workspace and the slug', () => {
    expect(canvasPath('w 1', 'my/slug')).toBe('/w/w%201/canvas/my%2Fslug')
    expect(workspacePath('w/1')).toBe('/w/w%2F1')
  })

  it('builds browser-local paths', () => {
    expect(browserLocalIndexPath()).toBe('/local')
    expect(browserLocalCanvasPath('abc-123')).toBe('/local/abc-123')
  })
})

describe('parseDaemonRoute', () => {
  it('parses the unscoped index route', () => {
    expect(parseDaemonRoute('/')).toEqual({ kind: 'index' })
  })

  it('parses a workspace-scoped index route', () => {
    expect(parseDaemonRoute('/w/w1')).toEqual({ kind: 'index', workspaceId: 'w1' })
  })

  it('parses a canvas route', () => {
    expect(parseDaemonRoute('/w/w1/canvas/main')).toEqual({
      kind: 'canvas',
      workspaceId: 'w1',
      slug: 'main',
    })
  })

  it('decodes percent-encoded segments', () => {
    expect(parseDaemonRoute('/w/w%201/canvas/my%2Fslug')).toEqual({
      kind: 'canvas',
      workspaceId: 'w 1',
      slug: 'my/slug',
    })
  })

  it('does not yet accept a multi-segment tail', () => {
    // The shape leaves room for a document path here, but the page below
    // still loads by slug through /api/canvas/:workspaceId/:slug — a URL the
    // app cannot open is worse than a not-found, so it stays not-a-route
    // until that data path converges too.
    expect(parseDaemonRoute('/w/w1/canvas/notes/2026/plan')).toBeNull()
  })

  it('is not confused by the workspace-index route it now nests under', () => {
    // `/w/w1` and `/w/w1/canvas/...` share a prefix; the canvas branch must
    // not swallow the bare workspace route, nor the reverse.
    expect(parseDaemonRoute('/w/w1')).toEqual({ kind: 'index', workspaceId: 'w1' })
    expect(parseDaemonRoute('/w/w1/canvas')).toBeNull()
  })

  it('returns null for an unrelated path (e.g. the browser-local route space)', () => {
    expect(parseDaemonRoute('/local/abc')).toBeNull()
    expect(parseDaemonRoute('/something/else')).toBeNull()
    // The retired shape is not a route any more.
    expect(parseDaemonRoute('/canvas/w1/main')).toBeNull()
  })

  it('round-trips through daemonRoutePath', () => {
    const route = parseDaemonRoute('/w/w1/canvas/main')
    expect(route).not.toBeNull()
    expect(daemonRoutePath(route!)).toBe('/w/w1/canvas/main')
  })
})

describe('daemonRoutePath', () => {
  it('builds the unscoped index path', () => {
    expect(daemonRoutePath({ kind: 'index' })).toBe('/')
  })

  it('builds a workspace-scoped index path', () => {
    expect(daemonRoutePath({ kind: 'index', workspaceId: 'w1' })).toBe('/w/w1')
  })

  it('builds a canvas path', () => {
    expect(daemonRoutePath({ kind: 'canvas', workspaceId: 'w1', slug: 'main' })).toBe(
      '/w/w1/canvas/main',
    )
  })
})

describe('parseBrowserLocalRoute', () => {
  it('parses a browser-local canvas route', () => {
    expect(parseBrowserLocalRoute('/local/abc-123')).toEqual({ canvasId: 'abc-123' })
  })

  it('returns null for the bare /local index and unrelated paths', () => {
    expect(parseBrowserLocalRoute('/local')).toBeNull()
    expect(parseBrowserLocalRoute('/w/w1/canvas/main')).toBeNull()
  })
})

// Both parsers run inside render-phase lazy initializers, so a URIError from a
// malformed percent sequence would crash the app rather than fall back to the
// index.
describe('malformed percent-encoding', () => {
  it('treats an undecodable segment as not-a-route instead of throwing', () => {
    expect(parseDaemonRoute('/w/w%1/canvas/main')).toBeNull()
    expect(parseDaemonRoute('/w/w1/canvas/ma%in')).toBeNull()
    expect(parseDaemonRoute('/w/%E0%A4%A')).toBeNull()
    expect(parseBrowserLocalRoute('/local/%zz')).toBeNull()
  })
})

describe('isKnownAppPath', () => {
  it('accepts every route in the closed set', () => {
    for (const p of [
      '/',
      '/w/ws1',
      '/w/ws1/canvas/main',
      '/local',
      '/local/c1',
      '/pair',
      '/settings',
      '/settings/general',
      '/settings/data',
      '/settings/connections',
    ]) {
      expect(isKnownAppPath(p)).toBe(true)
    }
  })

  it('rejects unknown paths so App can show not-found instead of silently falling through', () => {
    for (const p of [
      '/nope',
      '/canvas/ws1/main',
      '/w/ws1/canvas',
      '/local/a/b',
      '/w/',
      '/settings/nope',
    ]) {
      expect(isKnownAppPath(p)).toBe(false)
    }
  })
})

describe('settingsPath', () => {
  it('builds the settings index path with no section', () => {
    expect(settingsPath()).toBe('/settings')
  })

  it('builds a section-scoped settings path', () => {
    expect(settingsPath('general')).toBe('/settings/general')
    expect(settingsPath('data')).toBe('/settings/data')
    expect(settingsPath('connections')).toBe('/settings/connections')
  })
})

describe('parseSettingsRoute', () => {
  it('parses the settings index route with a null section', () => {
    expect(parseSettingsRoute('/settings')).toEqual({ section: null })
  })

  it('parses a section-scoped settings route', () => {
    expect(parseSettingsRoute('/settings/general')).toEqual({ section: 'general' })
    expect(parseSettingsRoute('/settings/data')).toEqual({ section: 'data' })
    expect(parseSettingsRoute('/settings/connections')).toEqual({ section: 'connections' })
  })

  it('returns null for an unknown section or unrelated path', () => {
    expect(parseSettingsRoute('/settings/nope')).toBeNull()
    expect(parseSettingsRoute('/local')).toBeNull()
  })
})
