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

describe('parseDaemonRoute', () => {
  it('parses the unscoped index route', () => {
    expect(parseDaemonRoute('/')).toEqual({ kind: 'index' })
  })

  it('parses a workspace-scoped index route', () => {
    expect(parseDaemonRoute('/w/w1')).toEqual({ kind: 'index', workspaceId: 'w1' })
  })

  it('parses a canvas route', () => {
    expect(parseDaemonRoute('/canvas/w1/main')).toEqual({
      kind: 'canvas',
      workspaceId: 'w1',
      slug: 'main',
    })
  })

  it('decodes percent-encoded segments', () => {
    expect(parseDaemonRoute('/canvas/w%201/my%2Fslug')).toEqual({
      kind: 'canvas',
      workspaceId: 'w 1',
      slug: 'my/slug',
    })
  })

  it('returns null for an unrelated path (e.g. the browser-local route space)', () => {
    expect(parseDaemonRoute('/local/abc')).toBeNull()
    expect(parseDaemonRoute('/something/else')).toBeNull()
  })

  it('round-trips through daemonRoutePath', () => {
    const route = parseDaemonRoute('/canvas/w1/main')
    expect(route).not.toBeNull()
    expect(daemonRoutePath(route!)).toBe('/canvas/w1/main')
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
      '/canvas/w1/main',
    )
  })
})

describe('parseBrowserLocalRoute', () => {
  it('parses a browser-local canvas route', () => {
    expect(parseBrowserLocalRoute('/local/abc-123')).toEqual({ canvasId: 'abc-123' })
  })

  it('returns null for the bare /local index and unrelated paths', () => {
    expect(parseBrowserLocalRoute('/local')).toBeNull()
    expect(parseBrowserLocalRoute('/canvas/w1/main')).toBeNull()
  })
})

// Both parsers run inside render-phase lazy initializers, so a URIError from a
// malformed percent sequence would crash the app rather than fall back to the
// index.
describe('malformed percent-encoding', () => {
  it('treats an undecodable segment as not-a-route instead of throwing', () => {
    expect(parseDaemonRoute('/canvas/w%1/main')).toBeNull()
    expect(parseDaemonRoute('/canvas/w1/ma%in')).toBeNull()
    expect(parseDaemonRoute('/w/%E0%A4%A')).toBeNull()
    expect(parseBrowserLocalRoute('/local/%zz')).toBeNull()
  })
})

describe('isKnownAppPath', () => {
  it('accepts every route in the closed set', () => {
    for (const p of [
      '/',
      '/w/ws1',
      '/canvas/ws1/main',
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
    for (const p of ['/nope', '/canvas/onlyws', '/local/a/b', '/w/', '/settings/nope']) {
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
