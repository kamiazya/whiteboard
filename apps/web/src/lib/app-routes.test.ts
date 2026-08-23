import { describe, expect, it } from 'vitest'
import {
  browserDocumentPath,
  browserIndexPath,
  daemonRoutePath,
  documentPath,
  indexPath,
  isKnownAppPath,
  parseBrowserRoute,
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
    expect(documentPath('w1', 'main')).toBe('/w/w1/document/main')
  })

  it('percent-encodes the workspace, and the path per segment', () => {
    expect(documentPath('w 1', 'my/path')).toBe('/w/w%201/document/my/path')
    expect(workspacePath('w/1')).toBe('/w/w%2F1')
  })

  it('builds browser paths', () => {
    expect(browserIndexPath()).toBe('/local')
    expect(browserDocumentPath('abc-123')).toBe('/local/abc-123')
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
    expect(parseDaemonRoute('/w/w1/document/main')).toEqual({
      kind: 'document',
      workspaceId: 'w1',
      path: 'main',
    })
  })

  it('accepts a multi-segment document path as the tail', () => {
    // The whole point of the shape: a document's path IS the URL's tail, one
    // URL segment per path segment, so the hierarchy the workspace shows is
    // the hierarchy the address bar shows. The data path below has been able
    // to load these since the documents family took paths.
    expect(parseDaemonRoute('/w/w1/document/notes/2026/plan')).toEqual({
      kind: 'document',
      workspaceId: 'w1',
      path: 'notes/2026/plan',
    })
  })

  it('round-trips a nested path through daemonRoutePath', () => {
    expect(
      daemonRoutePath({ kind: 'document', workspaceId: 'w1', path: 'notes/2026/plan' }),
    ).toEqual('/w/w1/document/notes/2026/plan')
  })

  it('decodes each tail segment separately, keeping the separators', () => {
    expect(parseDaemonRoute('/w/w1/document/a%20b/c%20d')).toEqual({
      kind: 'document',
      workspaceId: 'w1',
      path: 'a b/c d',
    })
    expect(documentPath('w1', 'a b/c d')).toBe('/w/w1/document/a%20b/c%20d')
  })

  it('treats a malformed segment anywhere in the tail as not-a-route', () => {
    expect(parseDaemonRoute('/w/w1/document/ok/ma%in')).toBeNull()
  })

  it('is not confused by the workspace-index route it now nests under', () => {
    // `/w/w1` and `/w/w1/document/...` share a prefix; the canvas branch must
    // not swallow the bare workspace route, nor the reverse.
    expect(parseDaemonRoute('/w/w1')).toEqual({ kind: 'index', workspaceId: 'w1' })
    expect(parseDaemonRoute('/w/w1/canvas')).toBeNull()
  })

  it('returns null for an unrelated path (e.g. the browser route space)', () => {
    expect(parseDaemonRoute('/local/abc')).toBeNull()
    expect(parseDaemonRoute('/something/else')).toBeNull()
    // The retired shape is not a route any more.
    expect(parseDaemonRoute('/document/w1/main')).toBeNull()
  })

  it('round-trips through daemonRoutePath', () => {
    const route = parseDaemonRoute('/w/w1/document/main')
    expect(route).not.toBeNull()
    expect(daemonRoutePath(route!)).toBe('/w/w1/document/main')
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
    expect(daemonRoutePath({ kind: 'document', workspaceId: 'w1', path: 'main' })).toBe(
      '/w/w1/document/main',
    )
  })
})

describe('parseBrowserRoute', () => {
  it('parses a document kept in this browser route', () => {
    expect(parseBrowserRoute('/local/abc-123')).toEqual({ path: 'abc-123' })
  })

  // The whole reason this changed: a local document has a real path now, and
  // a single-segment route cannot express one. Separators stay unencoded so
  // the hierarchy is visible in the URL, exactly as the daemon's is.
  it('parses a multi-segment path', () => {
    expect(parseBrowserRoute('/local/design/login')).toEqual({ path: 'design/login' })
    expect(parseBrowserRoute('/local/design/notes/kickoff')).toEqual({
      path: 'design/notes/kickoff',
    })
  })

  // The round trip alone is not enough: encoding the separator on the way out
  // and decoding it on the way back in agree with each other and produce a
  // URL that hides the hierarchy. Assert the STRING.
  it('leaves separators unencoded and encodes only the segments', () => {
    expect(browserDocumentPath('design/login')).toBe('/local/design/login')
    expect(browserDocumentPath('a b/c')).toBe('/local/a%20b/c')
    expect(parseBrowserRoute(browserDocumentPath('design/login'))).toEqual({
      path: 'design/login',
    })
  })

  // An empty segment would name nothing, and joined segments are what stop
  // `..` being expressible.
  it('refuses an empty segment', () => {
    expect(parseBrowserRoute('/local//login')).toBeNull()
    expect(parseBrowserRoute('/local/design//login')).toBeNull()
  })

  it('returns null for the bare /local index and unrelated paths', () => {
    expect(parseBrowserRoute('/local')).toBeNull()
    expect(parseBrowserRoute('/w/w1/document/main')).toBeNull()
  })
})

// Both parsers run inside render-phase lazy initializers, so a URIError from a
// malformed percent sequence would crash the app rather than fall back to the
// index.
describe('malformed percent-encoding', () => {
  it('treats an undecodable segment as not-a-route instead of throwing', () => {
    expect(parseDaemonRoute('/w/w%1/document/main')).toBeNull()
    expect(parseDaemonRoute('/w/w1/document/ma%in')).toBeNull()
    expect(parseDaemonRoute('/w/%E0%A4%A')).toBeNull()
    expect(parseBrowserRoute('/local/%zz')).toBeNull()
  })
})

describe('isKnownAppPath', () => {
  it('accepts every route in the closed set', () => {
    for (const p of [
      '/local/design/login',
      '/',
      '/w/ws1',
      '/w/ws1/document/main',
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
      '/document/ws1/main',
      '/w/ws1/canvas',
      // `/local/a/b` used to be here: a local document had no path, so a
      // second segment could only be a typo. It is a real address now.
      '/local//b',
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
