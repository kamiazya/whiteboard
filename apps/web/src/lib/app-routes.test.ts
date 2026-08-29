import { describe, expect, it } from 'vitest'
import {
  documentPath,
  indexPath,
  isKnownAppPath,
  parseSettingsRoute,
  parseWorkspaceRoute,
  settingsPath,
  workspacePath,
  workspaceRoutePath,
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

  it('builds one shape for both keepers, whatever the handle names', () => {
    // The browser used to have builders of its own producing `/local/*`. It
    // has none now, and that is the point: a `default`-segmented browser
    // workspace and a daemon's are the same kind of address.
    expect(documentPath('default', 'abc-123')).toBe('/w/default/document/abc-123')
    expect(documentPath('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'main')).toBe(
      '/w/01ARZ3NDEKTSV4RRFFQ69G5FAV/document/main',
    )
  })
})

describe('parseWorkspaceRoute', () => {
  it('parses the unscoped index route', () => {
    expect(parseWorkspaceRoute('/')).toEqual({ kind: 'index' })
  })

  it('parses a workspace-scoped index route', () => {
    expect(parseWorkspaceRoute('/w/w1')).toEqual({ kind: 'index', workspace: 'w1' })
  })

  it('parses a canvas route', () => {
    expect(parseWorkspaceRoute('/w/w1/document/main')).toEqual({
      kind: 'document',
      workspace: 'w1',
      path: 'main',
    })
  })

  it('accepts a multi-segment document path as the tail', () => {
    // The whole point of the shape: a document's path IS the URL's tail, one
    // URL segment per path segment, so the hierarchy the workspace shows is
    // the hierarchy the address bar shows. The data path below has been able
    // to load these since the documents family took paths.
    expect(parseWorkspaceRoute('/w/w1/document/notes/2026/plan')).toEqual({
      kind: 'document',
      workspace: 'w1',
      path: 'notes/2026/plan',
    })
  })

  it('round-trips a nested path through workspaceRoutePath', () => {
    expect(
      workspaceRoutePath({ kind: 'document', workspace: 'w1', path: 'notes/2026/plan' }),
    ).toEqual('/w/w1/document/notes/2026/plan')
  })

  it('decodes each tail segment separately, keeping the separators', () => {
    expect(parseWorkspaceRoute('/w/w1/document/a%20b/c%20d')).toEqual({
      kind: 'document',
      workspace: 'w1',
      path: 'a b/c d',
    })
    expect(documentPath('w1', 'a b/c d')).toBe('/w/w1/document/a%20b/c%20d')
  })

  it('treats a malformed segment anywhere in the tail as not-a-route', () => {
    expect(parseWorkspaceRoute('/w/w1/document/ok/ma%in')).toBeNull()
  })

  it('is not confused by the workspace-index route it now nests under', () => {
    // `/w/w1` and `/w/w1/document/...` share a prefix; the canvas branch must
    // not swallow the bare workspace route, nor the reverse.
    expect(parseWorkspaceRoute('/w/w1')).toEqual({ kind: 'index', workspace: 'w1' })
    expect(parseWorkspaceRoute('/w/w1/canvas')).toBeNull()
  })

  it('returns null for an unrelated path, the retired families included', () => {
    expect(parseWorkspaceRoute('/something/else')).toBeNull()
    // Both retired shapes. `/local/*` was the browser's own family until the
    // two became one; `/document/:ws/:path` predates the `/w/` nesting.
    expect(parseWorkspaceRoute('/local/abc')).toBeNull()
    expect(parseWorkspaceRoute('/document/w1/main')).toBeNull()
  })

  it('round-trips through workspaceRoutePath', () => {
    const route = parseWorkspaceRoute('/w/w1/document/main')
    expect(route).not.toBeNull()
    expect(workspaceRoutePath(route!)).toBe('/w/w1/document/main')
  })
})

describe('workspaceRoutePath', () => {
  it('builds the unscoped index path', () => {
    expect(workspaceRoutePath({ kind: 'index' })).toBe('/')
  })

  it('builds a workspace-scoped index path', () => {
    expect(workspaceRoutePath({ kind: 'index', workspace: 'w1' })).toBe('/w/w1')
  })

  it('builds a canvas path', () => {
    expect(workspaceRoutePath({ kind: 'document', workspace: 'w1', path: 'main' })).toBe(
      '/w/w1/document/main',
    )
  })
})

describe("a browser-kept workspace's address", () => {
  // These cases were `parseBrowserRoute`'s. They are kept, against the shared
  // parser, because what they pin is not which family a URL belongs to but
  // that a browser document's path survives the round trip with its hierarchy
  // visible — which is exactly as true now that there is one family.
  it('parses a document kept in this browser', () => {
    expect(parseWorkspaceRoute('/w/default/document/abc-123')).toEqual({
      kind: 'document',
      workspace: 'default',
      path: 'abc-123',
    })
  })

  it('parses a multi-segment path', () => {
    expect(parseWorkspaceRoute('/w/default/document/design/login')).toEqual({
      kind: 'document',
      workspace: 'default',
      path: 'design/login',
    })
  })

  // The round trip alone is not enough: encoding the separator on the way out
  // and decoding it on the way back in agree with each other and produce a
  // URL that hides the hierarchy. Assert the STRING.
  it('leaves separators unencoded and encodes only the segments', () => {
    expect(documentPath('default', 'design/login')).toBe('/w/default/document/design/login')
    expect(documentPath('default', 'a b/c')).toBe('/w/default/document/a%20b/c')
  })

  // An empty segment would name nothing, and joined segments are what stop
  // `..` being expressible.
  it('refuses an empty segment', () => {
    expect(parseWorkspaceRoute('/w/default/document//login')).toBeNull()
    expect(parseWorkspaceRoute('/w/default/document/design//login')).toBeNull()
  })

  it('reads a bare workspace address as that workspace index', () => {
    expect(parseWorkspaceRoute('/w/default')).toEqual({ kind: 'index', workspace: 'default' })
  })
})

// The parser runs inside render-phase lazy initializers, so a URIError from a
// malformed percent sequence would crash the app rather than fall back to the
// index.
describe('malformed percent-encoding', () => {
  it('treats an undecodable segment as not-a-route instead of throwing', () => {
    expect(parseWorkspaceRoute('/w/w%1/document/main')).toBeNull()
    expect(parseWorkspaceRoute('/w/w1/document/ma%in')).toBeNull()
    expect(parseWorkspaceRoute('/w/%E0%A4%A')).toBeNull()
    expect(parseWorkspaceRoute('/w/default/document/%zz')).toBeNull()
  })
})

describe('isKnownAppPath', () => {
  it('accepts every route in the closed set', () => {
    for (const p of [
      '/',
      '/w/ws1',
      '/w/ws1/document/main',
      '/w/default/document/design/login',
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
      // The retired browser family. It answered `true` here for as long as it
      // was a route; a stale bookmark to one must now read as not-found
      // rather than fall through to a silently different view.
      '/local',
      '/local/c1',
      '/w/default/document//b',
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
    expect(parseSettingsRoute('/w/w1')).toBeNull()
  })
})
