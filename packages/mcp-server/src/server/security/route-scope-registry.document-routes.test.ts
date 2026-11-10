// The document routes address a document by its ID and tell their actions
// apart by the suffix after it. A scope rule that read the suffix from the
// FRONT of a multi-segment path once decided by how a document was spelled;
// with one id segment there is no spelling, but the registry still has to put
// a version suffix under the versions grant and everything else under the
// document or workspace grant, whatever the verb. These cases ask the
// registry the question the router answers, for every registered suffix.

import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { resolveApiRouteScope, ruleClaiming } from './route-scope-registry.js'

const scoped = (...scopes: string[]) => ({ kind: 'scoped', scopes })
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const document = (suffix: string) => `/api/workspaces/ws1/documents/${ID}${suffix}`

// Every `onDocumentRoute` registration under /api/workspaces/:ws/documents/:id,
// as its routers mount it, by the rule that owns it.
const VERSION_ROUTES = [
  ['GET', '/versions'],
  ['GET', '/versions/:id/document'],
  ['POST', '/versions'],
  ['POST', '/versions/:id/restore'],
] as const
const WORKSPACE_ROUTES = [
  ['DELETE', ''],
  ['PUT', '/path'],
  ['POST', '/duplicate'],
  ['PUT', '/name'],
  ['PUT', '/pin'],
] as const
const CONTENT_ROUTES = [
  ['GET', '/snapshot'],
  ['GET', '/client-count'],
  ['POST', '/export-svg'],
] as const

describe('the version routes', () => {
  it.for([
    ['GET', '/versions', 'versions:read'],
    ['GET', '/versions/', 'versions:read'],
    ['GET', '/versions/01ABC/document', 'versions:read'],
    ['HEAD', '/versions/01ABC/document', 'versions:read'],
    ['POST', '/versions', 'versions:write'],
    ['POST', '/versions/01ABC/restore', 'versions:write'],
  ] as const)('%s …%s needs %s', ([method, suffix, scope]) => {
    expect(ruleClaiming(method, document(suffix))).toBe('document versions')
    expect(resolveApiRouteScope(method, document(suffix))).toEqual(scoped(scope))
  })
})

describe('the placement routes stay workspace writes', () => {
  it.for(WORKSPACE_ROUTES)('%s …%s', ([method, suffix]) => {
    expect(ruleClaiming(method, document(suffix))).toBe('workspaces (rest)')
    expect(resolveApiRouteScope(method, document(suffix))).toEqual(scoped('workspace:write'))
  })
})

describe('the content routes are canvas grants', () => {
  it.for([
    ['GET', '/snapshot', 'canvas:read'],
    ['GET', '/client-count', 'canvas:read'],
    ['POST', '/export-svg', 'canvas:write'],
  ] as const)('%s …%s needs %s', ([method, suffix, scope]) => {
    expect(ruleClaiming(method, document(suffix))).toBe('document content')
    expect(resolveApiRouteScope(method, document(suffix))).toEqual(scoped(scope))
  })

  it('the export writes a file, so it is a canvas write of its own', () => {
    expect(ruleClaiming('POST', document('/export'))).toBe('document export')
    expect(resolveApiRouteScope('POST', document('/export'))).toEqual(scoped('canvas:write'))
  })
})

// With one id segment a file id spelled like an action is unambiguous: under
// `/files/` it is a file, and only there.
describe('a file whose id is spelled like a document action', () => {
  it.for([
    ['GET', 'snapshot', 'files:read'],
    ['PUT', 'export', 'files:write'],
  ] as const)('%s …/files/%s needs %s alone', ([method, fileId, scope]) => {
    const path = document(`/files/${fileId}`)
    expect(ruleClaiming(method, path)).toBe('document file')
    expect(resolveApiRouteScope(method, path)).toEqual(scoped(scope))
  })
})

// Suffixes drawn from the routes' own vocabulary, with a verb drawn apart from
// them, so the generator lands on every (verb, suffix) pair the router does
// not mount as well as the ones it does. Uniform over every pair, a version
// route is about one draw in nine, so two arms aim at the version routes:
// one draws a mounted (verb, suffix) pair, one a version suffix under any verb.
const ROUTES = [...VERSION_ROUTES, ...WORKSPACE_ROUTES, ...CONTENT_ROUTES, ['POST', '/export']]
const METHOD = fc.constantFrom('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')
const pair = fc.oneof(
  fc.constantFrom(...VERSION_ROUTES).map(([method, suffix]) => ({ method, suffix })),
  fc.record({ method: METHOD, suffix: fc.constantFrom(...VERSION_ROUTES.map(([, s]) => s)) }),
  fc.record({ method: METHOD, suffix: fc.constantFrom(...ROUTES.map(([, s]) => s)) }),
)
const request = fc
  .record({
    pair,
    id: fc.constantFrom('01ABC', 'versions', 'document'),
    trailingSlash: fc.boolean(),
  })
  .map(({ pair: { method, suffix }, id, trailingSlash }) => ({
    method,
    url: `${document(suffix.replace(':id', id))}${trailingSlash ? '/' : ''}`,
  }))

// Which rule the router's own registration would put this request under, or
// null when no document route takes the verb. Hono answers HEAD with the GET
// handler.
const expectedRule = ({ method, url }: { method: string; url: string }): string | null => {
  const routedAs = method === 'HEAD' ? 'GET' : method
  const suffix = url.slice(document('').length).replace(/\/$/, '')
  for (const [m, pattern] of VERSION_ROUTES) {
    const re = new RegExp(`^${pattern.replace(':id', '[^/]+')}$`)
    if (m === routedAs && re.test(suffix)) return 'document versions'
  }
  return null
}

fcTest.prop([request], withDefaults())(
  'the registry scopes a request as versions exactly when a version route takes it',
  ({ method, url }) => {
    const expected = expectedRule({ method, url })
    if (expected !== null) expect(ruleClaiming(method, url)).toBe(expected)
    else expect(ruleClaiming(method, url)).not.toBe('document versions')
  },
)

it('the generator reaches the version routes and their lookalikes', () => {
  const sample = fc.sample(request, 2000)
  const versioned = sample.filter((r) => expectedRule(r) !== null)
  const lookalikes = sample.filter((r) => expectedRule(r) === null && r.url.includes('/versions'))
  expect(versioned.length).toBeGreaterThan(600)
  expect(lookalikes.length).toBeGreaterThan(300)
})
