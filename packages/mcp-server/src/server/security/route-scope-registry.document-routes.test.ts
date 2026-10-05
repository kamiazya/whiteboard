// The document routes address a document by a PATH of any depth and tell
// their actions apart by a suffix matched from the END of it
// (`matchDocumentsTail`, `documentPathForAction`). A scope rule that reads the
// same URL from the front instead decides by how the document happens to be
// spelled: one too narrow sends a nested document's version history to the
// workspace rule, and one too loose hands a document's own write to a
// versions grant. These cases ask the registry the question the router
// answers, for documents whose paths are spelled with the routes' own words.

import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { matchDocumentsTail } from '../routes/document/path-route.js'
import { resolveApiRouteScope, ruleClaiming } from './route-scope-registry.js'

const scoped = (...scopes: string[]) => ({ kind: 'scoped', scopes })
const documents = (tail: string) => `/api/workspaces/ws1/documents/${tail}`

// Every `onDocumentsRoute` registration under /api/workspaces/:ws/documents,
// as its router mounts it. The version routes are the ones the registry must
// set apart; every other one is a document operation at the workspace bar.
const VERSION_ROUTES = [
  ['GET', ['versions']],
  ['GET', ['versions', ':id', 'document']],
  ['POST', ['versions']],
  ['POST', ['versions', ':id', 'restore']],
] as const
const DOCUMENT_ROUTES = [
  ['DELETE', []],
  ['PUT', ['path']],
  ['POST', ['duplicate']],
  ['PUT', ['name']],
  ['PUT', ['pin']],
] as const

describe('the version routes, for a document at any depth', () => {
  it.for([
    ['GET', 'notes/plan/versions', 'versions:read'],
    ['GET', 'notes/2026/plan/versions/', 'versions:read'],
    ['GET', 'notes/plan/versions/01ABC/document', 'versions:read'],
    ['HEAD', 'notes/plan/versions/01ABC/document', 'versions:read'],
    ['POST', 'notes/plan/versions', 'versions:write'],
    ['POST', 'notes/plan/versions/01ABC/restore', 'versions:write'],
    // The document `a/versions`'s own history: the suffix is read from the end.
    ['GET', 'a/versions/versions', 'versions:read'],
    ['POST', 'a/versions/versions/01ABC/restore', 'versions:write'],
  ] as const)('%s %s needs %s', ([method, tail, scope]) => {
    expect(ruleClaiming(method, documents(tail))).toBe('document versions')
    expect(resolveApiRouteScope(method, documents(tail))).toEqual(scoped(scope))
  })
})

describe('a document whose path is spelled with a version route word', () => {
  it.for([
    ['POST', 'notes/versions-2026/duplicate'],
    ['PUT', 'notes/versions-2026/path'],
    ['DELETE', 'notes/versions-2026'],
    // Deleting the document `a/versions`, not anything about a's history.
    ['DELETE', 'a/versions'],
    ['DELETE', 'a/versions/01ABC/restore'],
    ['PUT', 'a/versions/name'],
    ['POST', 'a/versions/duplicate'],
  ] as const)('%s %s stays a workspace write', ([method, tail]) => {
    expect(ruleClaiming(method, documents(tail))).toBe('workspaces (rest)')
    expect(resolveApiRouteScope(method, documents(tail))).toEqual(scoped('workspace:write'))
  })
})

// Segments drawn mostly from the routes' own vocabulary, so the generator
// keeps landing on the spellings that can be read two ways. `%2F` stays
// encoded in the path a request is scoped by, and the router decodes it
// INSIDE one segment, so `x%2Fversions` is not a `versions` segment.
const segment = fc.constantFrom(
  'notes',
  'plan',
  'versions',
  'versions-2026',
  'document',
  'restore',
  'duplicate',
  'path',
  'name',
  'pin',
  '01ABC',
  'x%2Fversions',
)
const ROUTES = [...VERSION_ROUTES, ...DOCUMENT_ROUTES]
const request = fc
  .record({
    method: fc.constantFrom('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'),
    path: fc.array(segment, { minLength: 1, maxLength: 4 }),
    suffix: fc.constantFrom(...ROUTES.map(([, suffix]) => suffix)),
    id: segment,
    trailingSlash: fc.boolean(),
  })
  .map(({ method, path, suffix, id, trailingSlash }) => {
    const tail = [...path, ...suffix.map((s) => (s === ':id' ? id : s))].join('/')
    return { method, url: `${documents(tail)}${trailingSlash ? '/' : ''}` }
  })

// The document a version route would serve this request for, by the router's
// own parse — or null when no version route takes it. Hono answers HEAD with
// the GET handler.
const versionedDocument = ({ method, url }: { method: string; url: string }): string | null => {
  const routedAs = method === 'HEAD' ? 'GET' : method
  for (const [m, suffix] of VERSION_ROUTES) {
    const matched = m === routedAs ? matchDocumentsTail(url, [...suffix]) : null
    if (matched !== null) return matched.path
  }
  return null
}

fcTest.prop([request], withDefaults())(
  'the registry scopes a request as versions exactly when the router dispatches it to one',
  ({ method, url }) => {
    const expected =
      versionedDocument({ method, url }) === null ? 'workspaces (rest)' : 'document versions'
    expect(ruleClaiming(method, url)).toBe(expected)
  },
)

it('the generator reaches nested version routes and their lookalikes', () => {
  const sample = fc.sample(request, 2000)
  const nested = sample.filter((r) => versionedDocument(r)?.includes('/'))
  const lookalikes = sample.filter(
    (r) => versionedDocument(r) === null && r.url.includes('/versions'),
  )
  // Measured at 232-257 and 931-952 of 2000 over five runs.
  expect(nested.length).toBeGreaterThan(150)
  expect(lookalikes.length).toBeGreaterThan(700)
})

describe('a file whose id is spelled like a document action', () => {
  // The same tail is a file (GET/PUT `<path>/file/<id>`) and a document action
  // on the document `<path>/file`, and which answers depends on mount order —
  // so neither scope alone reaches it.
  it.for([
    ['POST', 'update', scoped('files:write', 'canvas:write')],
    ['POST', 'export', scoped('files:write', 'canvas:write')],
    ['POST', 'export-svg', scoped('files:write', 'canvas:write')],
    ['GET', 'snapshot', scoped('files:read', 'canvas:read')],
    ['GET', 'client-count', scoped('files:read', 'canvas:read')],
  ] as const)('%s …/a/file/%s needs both scopes', ([method, action, decision]) => {
    const path = `/api/w/ws1/document/a/file/${action}`
    expect(ruleClaiming(method, path)).toBe('document file/action overlap')
    expect(resolveApiRouteScope(method, path)).toEqual(decision)
  })

  // A file id is one segment, so a document filed under a `file` folder is a
  // document, and its actions answer to the document's scope alone.
  it.for([
    ['POST', 'update', 'document update/export', 'canvas:write'],
    ['POST', 'export-svg', 'document (rest)', 'canvas:write'],
    ['GET', 'snapshot', 'document (rest)', 'canvas:read'],
  ] as const)('%s on a document under a file folder, …/a/file/b/%s, is %s', ([
    method,
    action,
    rule,
    scope,
  ]) => {
    const path = `/api/w/ws1/document/a/file/b/${action}`
    expect(ruleClaiming(method, path)).toBe(rule)
    expect(resolveApiRouteScope(method, path)).toEqual(scoped(scope))
  })

  it.for([
    ['GET', 'files:read'],
    ['PUT', 'files:write'],
  ] as const)('%s on any other file id still needs %s alone', ([method, scope]) => {
    const path = '/api/w/ws1/document/notes/plan/file/V1StGXR8_Z5jdHi6B-myT'
    expect(ruleClaiming(method, path)).toBe('document file')
    expect(resolveApiRouteScope(method, path)).toEqual(scoped(scope))
  })
})
