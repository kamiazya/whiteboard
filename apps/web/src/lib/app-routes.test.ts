// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  documentPath,
  documentPathPrefix,
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
    expect(documentPath('w1', 'main')).toBe('/w/w1/d/main')
  })

  it('percent-encodes each address component, and the path per segment', () => {
    expect(documentPath('w 1', 'my/path')).toBe('/w/w%201/d/my/path')
    expect(workspacePath('me/w 1')).toBe('/w/me/w%201')
  })

  // ADR-0053: the namespace and the segment are two URL components, so the
  // separator between them is the address's own and stays unencoded.
  it('builds a qualified address as two components', () => {
    expect(workspacePath('me/design')).toBe('/w/me/design')
    expect(documentPath('ada/design', 'notes/plan')).toBe('/w/ada/design/d/notes/plan')
  })

  it('builds one shape for every keeper, whatever the address names', () => {
    // The browser used to have builders of its own producing `/local/*`. It
    // has none now, and that is the point: a browser workspace and a daemon's
    // are the same kind of address.
    expect(documentPath('me/default', 'abc-123')).toBe('/w/me/default/d/abc-123')
    expect(documentPath('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'main')).toBe(
      '/w/01ARZ3NDEKTSV4RRFFQ69G5FAV/d/main',
    )
  })
})

describe('parseWorkspaceRoute', () => {
  it('parses the unscoped index route', () => {
    expect(parseWorkspaceRoute('/')).toEqual({ kind: 'index' })
  })

  it('parses a workspace-scoped index route', () => {
    expect(parseWorkspaceRoute('/w/me/w1')).toEqual({ kind: 'index', workspace: 'me/w1' })
  })

  it('parses a canvas route', () => {
    expect(parseWorkspaceRoute('/w/me/w1/d/main')).toEqual({
      kind: 'document',
      workspace: 'me/w1',
      path: 'main',
    })
  })

  it('parses the opaque id form, with and without a document', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    expect(parseWorkspaceRoute(`/w/${id}`)).toEqual({ kind: 'index', workspace: id })
    expect(parseWorkspaceRoute(`/w/${id}/d/notes/plan`)).toEqual({
      kind: 'document',
      workspace: id,
      path: 'notes/plan',
    })
  })

  // A ULID-shaped first component is the id form, so a following `d` opens a
  // document there rather than naming a segment called `d`.
  it('reads the component after an id as the document marker', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    expect(parseWorkspaceRoute(`/w/${id}/d`)).toBeNull()
    expect(parseWorkspaceRoute(`/w/${id}/plans`)).toBeNull()
  })

  // Any other first component is a namespace, so a workspace whose segment
  // is `d` is still addressable, and its documents sit after a second `d`.
  it('reads a segment spelled `d` as a segment in a qualified address', () => {
    expect(parseWorkspaceRoute('/w/me/d')).toEqual({ kind: 'index', workspace: 'me/d' })
    expect(parseWorkspaceRoute('/w/me/d/d/x')).toEqual({
      kind: 'document',
      workspace: 'me/d',
      path: 'x',
    })
  })

  // Decision 2: old one-component segment links are not redirected. They
  // still parse — as an id-form address that names nothing — so they get the
  // same answer as any address naming nothing, not a different page.
  it('reads a one-component address as the id form, never as a segment', () => {
    expect(parseWorkspaceRoute('/w/design')).toEqual({ kind: 'index', workspace: 'design' })
    expect(parseWorkspaceRoute('/w/design/d/main')).toEqual({
      kind: 'document',
      workspace: 'design',
      path: 'main',
    })
  })

  it('refuses a qualified address the address grammar does not admit', () => {
    // A ULID-shaped segment and a non-path-safe one.
    expect(parseWorkspaceRoute('/w/me/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull()
    expect(parseWorkspaceRoute('/w/me/a%20b')).toBeNull()
  })

  it('accepts a multi-segment document path as the tail', () => {
    // The whole point of the shape: a document's path IS the URL's tail, one
    // URL segment per path segment, so the hierarchy the workspace shows is
    // the hierarchy the address bar shows. The data path below has been able
    // to load these since the documents family took paths.
    expect(parseWorkspaceRoute('/w/me/w1/d/notes/2026/plan')).toEqual({
      kind: 'document',
      workspace: 'me/w1',
      path: 'notes/2026/plan',
    })
  })

  it('round-trips a nested path through workspaceRoutePath', () => {
    expect(
      workspaceRoutePath({ kind: 'document', workspace: 'me/w1', path: 'notes/2026/plan' }),
    ).toEqual('/w/me/w1/d/notes/2026/plan')
  })

  it('decodes each tail segment separately, keeping the separators', () => {
    expect(parseWorkspaceRoute('/w/me/w1/d/a%20b/c%20d')).toEqual({
      kind: 'document',
      workspace: 'me/w1',
      path: 'a b/c d',
    })
    expect(documentPath('me/w1', 'a b/c d')).toBe('/w/me/w1/d/a%20b/c%20d')
  })

  it('treats a malformed segment anywhere in the tail as not-a-route', () => {
    expect(parseWorkspaceRoute('/w/me/w1/d/ok/ma%in')).toBeNull()
  })

  // A document path that decodes to a dot segment would be handed to the API
  // URL builders, where the URL parser resolves it to another `/api` route.
  it.each([
    '/w/me/w1/d/..',
    '/w/me/w1/d/a/./b',
    '/w/me/w1/d/a/%2e%2E',
    '/w/me/w1/d/%2e',
    '/w/01ARZ3NDEKTSV4RRFFQ69G5FAV/d/a/%2E%2e/b',
  ])('treats a dot segment in the tail as not-a-route: %s', (pathname) => {
    expect(parseWorkspaceRoute(pathname)).toBeNull()
  })

  it('keeps a tail segment that merely contains dots', () => {
    expect(parseWorkspaceRoute('/w/me/w1/d/a.b/...')).toEqual({
      kind: 'document',
      workspace: 'me/w1',
      path: 'a.b/...',
    })
  })

  it('is not confused by the workspace-index route it now nests under', () => {
    // `/w/me/w1` and `/w/me/w1/d/...` share a prefix; the document branch
    // must not swallow the workspace route, nor the reverse.
    expect(parseWorkspaceRoute('/w/me/w1')).toEqual({ kind: 'index', workspace: 'me/w1' })
    expect(parseWorkspaceRoute('/w/me/w1/canvas')).toBeNull()
  })

  it('returns null for an unrelated path, the retired families included', () => {
    expect(parseWorkspaceRoute('/something/else')).toBeNull()
    // Both retired shapes. `/local/*` was the browser's own family until the
    // two became one; `/document/:ws/:path` predates the `/w/` nesting.
    expect(parseWorkspaceRoute('/local/abc')).toBeNull()
    expect(parseWorkspaceRoute('/document/w1/main')).toBeNull()
  })

  it('round-trips through workspaceRoutePath', () => {
    for (const path of [
      '/w/me/w1/d/main',
      '/w/ada/w1',
      '/w/01ARZ3NDEKTSV4RRFFQ69G5FAV/d/main',
      '/w/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ]) {
      const route = parseWorkspaceRoute(path)
      expect(route).not.toBeNull()
      expect(workspaceRoutePath(route!)).toBe(path)
    }
  })
})

describe('workspaceRoutePath', () => {
  it('builds the unscoped index path', () => {
    expect(workspaceRoutePath({ kind: 'index' })).toBe('/')
  })

  it('builds a workspace-scoped index path', () => {
    expect(workspaceRoutePath({ kind: 'index', workspace: 'me/w1' })).toBe('/w/me/w1')
  })

  it('builds a canvas path', () => {
    expect(workspaceRoutePath({ kind: 'document', workspace: 'me/w1', path: 'main' })).toBe(
      '/w/me/w1/d/main',
    )
  })
})

describe("a browser-kept workspace's address", () => {
  // These cases were `parseBrowserRoute`'s. They are kept, against the shared
  // parser, because what they pin is not which family a URL belongs to but
  // that a browser document's path survives the round trip with its hierarchy
  // visible — which is exactly as true now that there is one family.
  it('parses a document kept in this browser', () => {
    expect(parseWorkspaceRoute('/w/me/default/d/abc-123')).toEqual({
      kind: 'document',
      workspace: 'me/default',
      path: 'abc-123',
    })
  })

  it('parses a multi-segment path', () => {
    expect(parseWorkspaceRoute('/w/me/default/d/design/login')).toEqual({
      kind: 'document',
      workspace: 'me/default',
      path: 'design/login',
    })
  })

  // The round trip alone is not enough: encoding the separator on the way out
  // and decoding it on the way back in agree with each other and produce a
  // URL that hides the hierarchy. Assert the STRING.
  it('leaves separators unencoded and encodes only the segments', () => {
    expect(documentPath('me/default', 'design/login')).toBe('/w/me/default/d/design/login')
    expect(documentPath('me/default', 'a b/c')).toBe('/w/me/default/d/a%20b/c')
  })

  // An empty segment would name nothing, and joined segments are what stop
  // `..` being expressible.
  it('refuses an empty segment', () => {
    expect(parseWorkspaceRoute('/w/me/default/d//login')).toBeNull()
    expect(parseWorkspaceRoute('/w/me/default/d/design//login')).toBeNull()
  })

  it('reads a workspace address as that workspace index', () => {
    expect(parseWorkspaceRoute('/w/me/default')).toEqual({
      kind: 'index',
      workspace: 'me/default',
    })
  })
})

// The parser runs inside render-phase lazy initializers, so a URIError from a
// malformed percent sequence would crash the app rather than fall back to the
// index.
describe('malformed percent-encoding', () => {
  it('treats an undecodable segment as not-a-route instead of throwing', () => {
    expect(parseWorkspaceRoute('/w/w%1/d/main')).toBeNull()
    expect(parseWorkspaceRoute('/w/me/w1/d/ma%in')).toBeNull()
    expect(parseWorkspaceRoute('/w/me/w%1')).toBeNull()
    expect(parseWorkspaceRoute('/w/%E0%A4%A')).toBeNull()
    expect(parseWorkspaceRoute('/w/me/default/d/%zz')).toBeNull()
  })
})

describe('isKnownAppPath', () => {
  it('accepts every route in the closed set', () => {
    for (const p of [
      '/',
      '/w/me/ws1',
      '/w/me/ws1/d/main',
      '/w/me/default/d/design/login',
      '/w/01ARZ3NDEKTSV4RRFFQ69G5FAV/d/main',
      '/settings',
      '/settings/general',
      '/settings/data',
      '/settings/connections',
      '/settings/developer',
    ]) {
      expect(isKnownAppPath(p)).toBe(true)
    }
  })

  it('rejects unknown paths so App can show not-found instead of silently falling through', () => {
    for (const p of [
      '/nope',
      '/document/ws1/main',
      '/w/me/ws1/canvas',
      // The retired browser family. It answered `true` here for as long as it
      // was a route; a stale bookmark to one must now read as not-found
      // rather than fall through to a silently different view.
      '/local',
      '/local/c1',
      // The daemon's consent page. A local daemon is reached through the
      // extension (ADR-0050), so there is no pairing to consent to.
      '/pair',
      '/w/me/default/d//b',
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
    expect(settingsPath('developer')).toBe('/settings/developer')
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
    expect(parseSettingsRoute('/settings/developer')).toEqual({ section: 'developer' })
  })

  it('returns null for an unknown section or unrelated path', () => {
    expect(parseSettingsRoute('/settings/nope')).toBeNull()
    expect(parseSettingsRoute('/w/w1')).toBeNull()
  })
})

describe('documentPathPrefix', () => {
  // The form fields that edit a document's path draw this in front of the
  // box, so a person can see the URL their text lands in. That only stays
  // true if it is the SAME string the router builds — a hand-written `/w/…/d/`
  // in a component would keep reading right long after the grammar moved.
  it('is the literal head of the URL a document is addressed at', () => {
    expect(documentPath('me/design-team', 'design/login')).toBe(
      `${documentPathPrefix('me/design-team')}design/login`,
    )
  })

  it('encodes the address the same way the full URL does', () => {
    expect(documentPathPrefix('me/w 1')).toBe('/w/me/w%201/d/')
  })
})
