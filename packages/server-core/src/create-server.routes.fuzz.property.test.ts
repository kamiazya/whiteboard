/**
 * Every `/api/v1` route, requested with what its own input schema admits —
 * and with what it does not.
 *
 * The route lane is the tool lane's sibling (`tools/tool-inputs.fuzz`):
 * the same seeded workspace, the same question asked of the HTTP surface a
 * browser reaches instead of the MCP surface a model reaches. A route may
 * answer (2xx), refuse a request it understood (4xx with a JSON body naming
 * why), and nothing else: a 5xx is a stack trace where a reason should be,
 * and a body that is not JSON is one the client cannot read. A body drawn
 * from the route's OWN schema, aimed at the seeded workspace, must never
 * come back `invalid input` — the route re-parses `{ params, ...body }`
 * with that schema, so that refusal is the route and the schema
 * disagreeing about what the schema says.
 *
 * Bodies are drawn three ways at real weight: from the schema, as any JSON
 * at all, and as text that is not JSON — because the parse that answers
 * 400 for the last two is a branch the schema-drawn body never reaches.
 */
import { documentIdSchema, documentPathSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { arbitraryForSchema, sameSchema } from '@kamiazya/whiteboard-model/test-utils'
import { afterAll, describe, expect } from 'vitest'
import type { z } from 'zod'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  MISSING_DOCUMENT_ID,
  SEEDED_MARKDOWN_ID,
  SEEDED_MARKDOWN_PATH,
  SEEDED_SPATIAL_ID,
  SEEDED_SPATIAL_PATH,
  SEEDED_WORKSPACE_ID,
  seededServer,
} from './test-utils/seeded-workspace.js'
import { backlinksInputSchema, backlinksOutputSchema } from './tools/backlinks.js'
import {
  wbDocumentCreateInputSchema,
  wbDocumentCreateOutputSchema,
  wbDocumentDeleteInputSchema,
  wbDocumentDeleteOutputSchema,
  wbDocumentListInputSchema,
  wbDocumentListOutputSchema,
  wbDocumentResolveInputSchema,
  wbDocumentResolveOutputSchema,
} from './tools/document-crud.schemas.js'
import { documentSearchInputSchema, documentSearchOutputSchema } from './tools/document-search.js'
import { documentTagsInputSchema, documentTagsOutputSchema } from './tools/document-tags.js'
import { exportOkfInputSchema, exportOkfOutputSchema } from './tools/export-okf.js'
import {
  linkifyMentionsInputSchema,
  linkifyMentionsOutputSchema,
} from './tools/linkify-mentions.js'

/**
 * A path segment the URL parser leaves alone. `.` and `..` are resolved
 * away before any route sees them (`/workspaces/./documents` routes as
 * `/workspaces/documents`), so a draw of either asks a question of the
 * parser, not of the route — and gets Hono's plain-text 404 for a path
 * nothing registered, which is neither a route answering nor refusing.
 */
const reachesRoute = (segment: string) =>
  new URL(`http://fuzz/${encodeURIComponent(segment)}`).pathname ===
  `/${encodeURIComponent(segment)}`

/** The seeded workspace mostly, a workspace that does not exist, and a segment that is not even well-formed. */
const workspaceArb = fc.oneof(
  { weight: 6, arbitrary: fc.constant(SEEDED_WORKSPACE_ID) },
  { weight: 1, arbitrary: fc.constant('nowhere') },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 8 }).filter(reachesRoute) },
)
const documentArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant(SEEDED_SPATIAL_ID) },
  { weight: 3, arbitrary: fc.constant(SEEDED_MARKDOWN_ID) },
  { weight: 1, arbitrary: fc.constant(MISSING_DOCUMENT_ID) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 8 }).filter(reachesRoute) },
)

const OKF_NOTE = '---\ntype: note\ntags: [a]\n---\n# Title\n\nA body.\n'

/** Ids and paths inside a body follow the seeded workspace the way the tool lane's do. */
const override = (path: string, schema: z.ZodTypeAny): fc.Arbitrary<unknown> | undefined => {
  if (sameSchema(schema, workspaceIdSchema)) return fc.constant(SEEDED_WORKSPACE_ID)
  if (sameSchema(schema, documentIdSchema)) {
    return fc.constantFrom(SEEDED_SPATIAL_ID, SEEDED_MARKDOWN_ID, MISSING_DOCUMENT_ID)
  }
  if (sameSchema(schema, documentPathSchema)) {
    return fc.constantFrom('fresh', 'notes/other', SEEDED_SPATIAL_PATH, SEEDED_MARKDOWN_PATH)
  }
  // OKF that parses, mostly; a note that does not is the refusal the
  // create route owes a reason for.
  if (path.endsWith('.markdown')) {
    return fc.oneof(
      { weight: 3, arbitrary: fc.constant(OKF_NOTE) },
      { weight: 1, arbitrary: fc.string({ maxLength: 20 }) },
    )
  }
  return undefined
}

/** A body from the schema (the path's own fields removed — the route supplies those), any JSON, or not JSON. */
type Body =
  | { readonly kind: 'schema'; readonly json: unknown }
  | { readonly kind: 'json'; readonly json: unknown }
  | { readonly kind: 'text'; readonly text: string }
function bodyArb(schema: z.ZodTypeAny, pathFields: readonly string[]): fc.Arbitrary<Body> {
  const fromSchema = arbitraryForSchema(schema, { override }).map((drawn): Body => {
    const record = { ...(drawn as Record<string, unknown>) }
    for (const field of pathFields) delete record[field]
    return { kind: 'schema', json: record }
  })
  return fc.oneof(
    { weight: 4, arbitrary: fromSchema },
    {
      weight: 1,
      arbitrary: fc.jsonValue({ maxDepth: 2 }).map((json): Body => ({ kind: 'json', json })),
    },
    {
      weight: 1,
      arbitrary: fc.string({ maxLength: 12 }).map((text): Body => ({ kind: 'text', text })),
    },
  )
}

/** The search route reads its input off the query string; this draws the string from the schema. */
const searchQueryArb = arbitraryForSchema(documentSearchInputSchema, { override }).map((drawn) => {
  const input = drawn as { query?: string; kind?: string; tags?: string[]; limit?: number }
  const params = new URLSearchParams()
  if (input.query !== undefined) params.set('q', input.query)
  if (input.kind !== undefined) params.set('kind', input.kind)
  for (const tag of input.tags ?? []) params.append('tag', tag)
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  return params.toString()
})

interface Route {
  readonly name: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  /** The pattern Hono registers, so the table is checked against what the app actually serves. */
  readonly pattern: string
  /** The schema the route parses with — one per row, and the row's own generator draws from it. */
  readonly schema: z.ZodTypeAny
  /**
   * The schema a typed client reads the answer with. A 2xx body that fails
   * it is drift between what the route emits and what its readers expect —
   * the route's handler is typed, but nothing parses on the way out.
   */
  readonly response: z.ZodTypeAny
  readonly request: fc.Arbitrary<{ path: string; body?: Body; seeded: boolean }>
}

const ws = (id: string) => `/api/v1/workspaces/${encodeURIComponent(id)}`
const doc = (workspace: string, id: string) =>
  `${ws(workspace)}/documents/${encodeURIComponent(id)}`
const isSeededDocument = (id: string) => id === SEEDED_SPATIAL_ID || id === SEEDED_MARKDOWN_ID

const ROUTES: readonly Route[] = [
  {
    name: 'POST documents',
    method: 'POST',
    pattern: '/api/v1/workspaces/:workspaceId/documents',
    schema: wbDocumentCreateInputSchema,
    response: wbDocumentCreateOutputSchema,
    request: fc
      .tuple(workspaceArb, bodyArb(wbDocumentCreateInputSchema, ['workspaceId']))
      .map(([w, body]) => ({
        path: `${ws(w)}/documents`,
        body,
        seeded: w === SEEDED_WORKSPACE_ID,
      })),
  },
  {
    name: 'GET documents',
    method: 'GET',
    pattern: '/api/v1/workspaces/:workspaceId/documents',
    schema: wbDocumentListInputSchema,
    response: wbDocumentListOutputSchema,
    request: workspaceArb.map((w) => ({
      path: `${ws(w)}/documents`,
      seeded: w === SEEDED_WORKSPACE_ID,
    })),
  },
  {
    name: 'GET documents/:id',
    method: 'GET',
    pattern: '/api/v1/workspaces/:workspaceId/documents/:documentId',
    schema: wbDocumentResolveInputSchema,
    response: wbDocumentResolveOutputSchema,
    request: fc.tuple(workspaceArb, documentArb).map(([w, d]) => ({
      path: doc(w, d),
      seeded: w === SEEDED_WORKSPACE_ID && isSeededDocument(d),
    })),
  },
  {
    name: 'DELETE documents/:id',
    method: 'DELETE',
    pattern: '/api/v1/workspaces/:workspaceId/documents/:documentId',
    schema: wbDocumentDeleteInputSchema,
    response: wbDocumentDeleteOutputSchema,
    request: fc.tuple(workspaceArb, documentArb).map(([w, d]) => ({
      path: doc(w, d),
      seeded: w === SEEDED_WORKSPACE_ID && isSeededDocument(d),
    })),
  },
  {
    name: 'GET search',
    method: 'GET',
    pattern: '/api/v1/workspaces/:workspaceId/search',
    schema: documentSearchInputSchema,
    response: documentSearchOutputSchema,
    request: fc.tuple(workspaceArb, searchQueryArb).map(([w, query]) => ({
      path: `${ws(w)}/search?${query}`,
      seeded: w === SEEDED_WORKSPACE_ID,
    })),
  },
  {
    name: 'GET document-tags',
    method: 'GET',
    pattern: '/api/v1/workspaces/:workspaceId/document-tags',
    schema: documentTagsInputSchema,
    response: documentTagsOutputSchema,
    request: workspaceArb.map((w) => ({
      path: `${ws(w)}/document-tags`,
      seeded: w === SEEDED_WORKSPACE_ID,
    })),
  },
  {
    name: 'POST documents/:id/linkify-mentions',
    method: 'POST',
    pattern: '/api/v1/workspaces/:workspaceId/documents/:documentId/linkify-mentions',
    schema: linkifyMentionsInputSchema,
    response: linkifyMentionsOutputSchema,
    request: fc
      .tuple(
        workspaceArb,
        documentArb,
        bodyArb(linkifyMentionsInputSchema, ['workspaceId', 'documentId']),
      )
      .map(([w, d, body]) => ({
        path: `${doc(w, d)}/linkify-mentions`,
        body,
        seeded: w === SEEDED_WORKSPACE_ID && isSeededDocument(d),
      })),
  },
  {
    name: 'GET documents/:id/backlinks',
    method: 'GET',
    pattern: '/api/v1/workspaces/:workspaceId/documents/:documentId/backlinks',
    schema: backlinksInputSchema,
    response: backlinksOutputSchema,
    request: fc.tuple(workspaceArb, documentArb).map(([w, d]) => ({
      path: `${doc(w, d)}/backlinks`,
      seeded: w === SEEDED_WORKSPACE_ID && isSeededDocument(d),
    })),
  },
  {
    name: 'GET documents/:id/okf',
    method: 'GET',
    pattern: '/api/v1/workspaces/:workspaceId/documents/:documentId/okf',
    schema: exportOkfInputSchema,
    response: exportOkfOutputSchema,
    request: fc.tuple(workspaceArb, documentArb).map(([w, d]) => ({
      path: `${doc(w, d)}/okf`,
      seeded: w === SEEDED_WORKSPACE_ID && isSeededDocument(d),
    })),
  },
]

const answered = new Map<string, number>()

describe('every /api/v1 route answers or refuses with a reason, never a 5xx', () => {
  // Read off the app itself, so a route added to `createServer` without a
  // row here fails rather than staying unfuzzed. Middleware registers as
  // `ALL` and is not a route.
  fcTest.prop([fc.constant(null)])('every route the app registers has a row here', async () => {
    const { app } = await seededServer()
    const registered = app.routes
      .filter((route) => route.method !== 'ALL')
      .map((route) => `${route.method} ${route.path}`)
    const rows = ROUTES.map((route) => `${route.method} ${route.pattern}`)
    expect([...new Set(registered)].sort()).toEqual([...new Set(rows)].sort())
  })

  for (const route of ROUTES) {
    fcTest.prop([route.request], withDefaults({ numRuns: 60 }))(route.name, async (request) => {
      // Fresh state per request: a delete must not leave the next draw a
      // workspace the others never see.
      const { app } = await seededServer()
      const init: RequestInit = { method: route.method }
      if (request.body !== undefined) {
        init.body =
          request.body.kind === 'text' ? request.body.text : JSON.stringify(request.body.json)
        init.headers = { 'content-type': 'application/json' }
      }
      const response = await app.fetch(new Request(`http://fuzz${request.path}`, init))
      const text = await response.text()
      const detail = `${route.method} ${request.path} ${init.body ?? ''} -> ${response.status} ${text.slice(0, 200)}`
      expect(response.status, detail).toBeLessThan(500)
      expect(() => JSON.parse(text), detail).not.toThrow()
      if (response.status < 300) {
        answered.set(route.name, (answered.get(route.name) ?? 0) + 1)
        const read = route.response.safeParse(JSON.parse(text))
        expect(read.success, `${detail}\n${JSON.stringify(read.error?.issues)}`).toBe(true)
      }
      // A body the schema produced, on the seeded workspace, is one the
      // route's own parse must accept: `invalid input` there is drift
      // between the route's composition of params and body, and the
      // schema. A 400 with another reason is the route refusing a request
      // it understood (a target with no name to linkify), which is its
      // call to make.
      if (request.seeded && request.body?.kind === 'schema' && response.status === 400) {
        expect(JSON.parse(text), detail).not.toMatchObject({ error: 'invalid input' })
      }
    })
  }

  afterAll(() => {
    const silent = ROUTES.map((r) => r.name).filter((name) => (answered.get(name) ?? 0) === 0)
    expect(
      silent,
      `routes this lane never got a 2xx from: ${JSON.stringify([...answered])}`,
    ).toEqual([])
  })
})
