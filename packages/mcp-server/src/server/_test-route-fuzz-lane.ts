// The machinery the route fuzz lanes share: what a rule says a route may do,
// how a reply is judged against it, and one row per rule over a seeded
// composition. The compositions themselves (what to seed, how to authenticate)
// are each lane's own, so a route is requested only with credentials that can
// reach it. Test support only: excluded from the build by its `_test-` prefix.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { signInRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/sign-in'
import { arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { apiErrorBodySchema } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { expect } from 'vitest'
import { z } from 'zod'
import { fc, fcTest, withDefaults } from '../shared/test-utils/fast-check.js'
import { IDP } from './_test-server-mode-harness.js'

// ---------------------------------------------------------------------------
// What each route may do, keyed by `METHOD pattern` as the app registers it
// (wildcards expanded with their action). `answers` is what a 2xx carries;
// `refuses-only:` says why the seeding cannot reach one and is checked to
// still be true; `skip:` says why the lane does not request it at all.
// ---------------------------------------------------------------------------
export type Rule =
  | {
      /** `redirect`: a 3xx whose Location is the provider's, this origin's own path, or the sign-in screen naming a refusal. */
      readonly answers: 'json' | 'bytes' | 'none' | 'redirect'
      readonly body?: z.ZodTypeAny
      readonly raw?: true
      /** What raw bytes are sent as; the file route stores images only. */
      readonly contentType?: string
      /** Fewer draws for a route whose every answer is a real render. */
      readonly runs?: number
      /**
       * The schema a typed client reads a 2xx with. A body that fails it is
       * drift between what the route emits and what its readers expect —
       * the handler is typed, but nothing parses on the way out. Absent
       * where no client contract exists for the answer.
       */
      readonly response?: z.ZodTypeAny
    }
  | { readonly refusesOnly: string; readonly body?: z.ZodTypeAny }
  | { readonly skip: string }

/** A segment the URL parser leaves alone (`.` and `..` resolve away before any route sees them). */
const reachesRoute = (segment: string) =>
  new URL(`http://fuzz/${encodeURIComponent(segment)}`).pathname ===
  `/${encodeURIComponent(segment)}`
export const segmentArb = fc.string({ minLength: 1, maxLength: 8 }).filter(reachesRoute)

export type Override = (path: string, schema: z.ZodTypeAny) => fc.Arbitrary<unknown> | undefined

type Body =
  | { readonly kind: 'json'; readonly json: unknown }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }

/** A real Loro update — one map write from a fresh peer — so a raw-bytes route can answer. */
const loroUpdateArb = fc.string({ maxLength: 6 }).map((value) => {
  const doc = new LoroDoc()
  const from = doc.version()
  doc.getMap('fuzz').set('k', value)
  doc.commit()
  return doc.export({ mode: 'update', from })
})

function bodyArb(method: string, rule: Rule, override: Override): fc.Arbitrary<Body | undefined> {
  if (method === 'GET') return fc.constant(undefined)
  const schema = 'body' in rule ? rule.body : undefined
  const raw = 'raw' in rule && rule.raw === true
  const arms: fc.WeightedArbitrary<Body | undefined>[] = [
    {
      weight: 1,
      arbitrary: fc.jsonValue({ maxDepth: 2 }).map((json): Body => ({ kind: 'json', json })),
    },
    {
      weight: 1,
      arbitrary: fc.string({ maxLength: 12 }).map((text): Body => ({ kind: 'text', text })),
    },
    { weight: 1, arbitrary: fc.constant(undefined) },
  ]
  if (schema !== undefined) {
    arms.push({
      weight: 5,
      arbitrary: arbitraryForSchema(schema, { override }).map(
        (json): Body => ({ kind: 'json', json }),
      ),
    })
  }
  if (raw) {
    arms.push(
      {
        weight: 2,
        arbitrary: fc
          .uint8Array({ maxLength: 64 })
          .map((bytes): Body => ({ kind: 'bytes', bytes })),
      },
      { weight: 3, arbitrary: loroUpdateArb.map((bytes): Body => ({ kind: 'bytes', bytes })) },
    )
  }
  return fc.oneof(...arms)
}

// ---------------------------------------------------------------------------
// The registered surface: plain routes off `app.routes`, wildcard actions off
// the registration calls in the source.
// ---------------------------------------------------------------------------
const ROUTES_DIR = join(import.meta.dirname, 'routes')

function wildcardKeysIn(source: string): string[] {
  const keys: string[] = []
  for (const m of source.matchAll(/onDocumentAction\(\s*app,\s*'(\w+)',\s*'([\w-]+)'/g)) {
    keys.push(`${m[1]!.toUpperCase()} /api/w/:workspaceId/document/*/${m[2]}`)
  }
  for (const m of source.matchAll(/onDocumentFile\(\s*app,\s*'(\w+)'/g)) {
    keys.push(`${m[1]!.toUpperCase()} /api/w/:workspaceId/document/*/file/:fileId`)
  }
  for (const m of source.matchAll(/onDocumentsRoute\(\s*app,\s*'(\w+)',\s*\[([^\]]*)\]/g)) {
    const suffix = [...m[2]!.matchAll(/'([^']+)'/g)].map((s) => s[1]).join('/')
    keys.push(
      `${m[1]!.toUpperCase()} /api/workspaces/:workspaceId/documents/*${suffix === '' ? '' : `/${suffix}`}`,
    )
  }
  return keys
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(full)
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [full] : []
  })
}

const WILDCARDS = new Set([
  '/api/w/:workspaceId/document/*',
  '/api/workspaces/:workspaceId/documents/*',
])

/** A route a lane requests: not a catch-all, not server-core's own mount, not a wildcard pattern. */
function isRequestable(route: { method: string; path: string }): boolean {
  if (route.method === 'ALL') return false
  if (route.path === '*' || route.path === '/*') return false
  // server-core's mount, fuzzed by its own lane against its own seed.
  return !route.path.startsWith('/api/v1/') && !WILDCARDS.has(route.path)
}

export function registeredKeys(app: {
  routes: readonly { method: string; path: string }[]
}): string[] {
  const keys = new Set(app.routes.filter(isRequestable).map((r) => `${r.method} ${r.path}`))
  for (const file of sourcesUnder(ROUTES_DIR)) {
    for (const key of wildcardKeysIn(readFileSync(file, 'utf8'))) keys.add(key)
  }
  return [...keys].sort()
}

// ---------------------------------------------------------------------------
// One composition, as the rows below see it: something to send a request to,
// a generator for what to send it, and a way to put it away.
// ---------------------------------------------------------------------------
export interface Target {
  readonly path: string
  /** Credentials and anything else the request carries beside its body. */
  readonly headers: Record<string, string>
}

export interface Harness {
  request(path: string, init: RequestInit): Response | Promise<Response>
  target(key: string, pattern: string): fc.Arbitrary<Target>
  readonly override: Override
  dispose(): Promise<void>
}

/**
 * What server mode's `/api` auth middleware answers a credential it refuses
 * with: `auth.required` (401) and `auth.forbidden` (403), the codes
 * `AuthDecision` pins one to one with their status. They are dotted, which
 * `apiErrorCodeSchema` (lowercase snake_case) does not admit, so they are not
 * `apiErrorBodySchema` bodies — the one place a refusal here is read under a
 * different contract, named rather than waved through.
 */
const serverModeAuthRefusalSchema = z.union([
  z.object({
    status: z.literal(401),
    body: z.object({ error: z.literal('auth.required') }).strict(),
  }),
  z.object({
    status: z.literal(403),
    body: z.object({ error: z.literal('auth.forbidden') }).strict(),
  }),
])

/** A redirect that goes anywhere but the provider or a path on this origin is an open redirect. */
function staysOnThisOriginOrGoesToTheProvider(location: string): boolean {
  if (location.startsWith(`${IDP}/authorize?`)) return true
  return location.startsWith('/') && !location.startsWith('//') && !location.includes('\\')
}

const answersWith = (rule: Rule, kind: 'json' | 'bytes' | 'none' | 'redirect') =>
  'answers' in rule && rule.answers === kind

/** True when a redirect is an answer, false when it refuses by naming a reason. */
function judgeRedirect(rule: Rule, res: Response, detail: string): boolean {
  expect(answersWith(rule, 'redirect'), detail).toBe(true)
  const location = res.headers.get('location') ?? ''
  // The callback is a browser navigation: it refuses by sending the person
  // to the sign-in screen with a reason that screen can explain.
  const refused = /^\/sign-in\?error=(.*)$/.exec(location)
  if (refused !== null) {
    expect(signInRefusalSchema.safeParse(refused[1]).success, detail).toBe(true)
    return false
  }
  expect(staysOnThisOriginOrGoesToTheProvider(location), detail).toBe(true)
  return true
}

/** A refusal's body under the contract the web client reads it with, snake_case code included. */
function judgeRefusal(res: Response, text: string, detail: string): void {
  // The runtime half of `routes/error-body-shape.test.ts`. That scan reads
  // object LITERALS, so it cannot see a body built by `errorBody`, whose
  // `code` parameter is a plain `string` — a sentence passed to it
  // typechecks. This parses what actually went out.
  const body: unknown = JSON.parse(text)
  const refusal = apiErrorBodySchema.safeParse(body)
  const refusedByAuth = serverModeAuthRefusalSchema.safeParse({ status: res.status, body })
  expect(
    refusal.success || refusedByAuth.success,
    `${detail}\n${JSON.stringify(refusal.error?.issues)}`,
  ).toBe(true)
}

/** What kind of reply this is, against what the rule says its answers are. */
function judgeKind(rule: Rule, res: Response, isJson: boolean, text: string, detail: string): void {
  if (isJson) expect(() => JSON.parse(text), detail).not.toThrow()
  else if (res.status === 204) expect(answersWith(rule, 'none'), detail).toBe(true)
  else if (res.status < 300) expect(answersWith(rule, 'bytes'), detail).toBe(true)
  // A refusal the client cannot read.
  else expect.fail(detail)
}

/** True when the reply is an answer rather than a refusal; throws (via expect) when it is neither. */
function judge(rule: Rule, res: Response, text: string, detail: string): boolean {
  const isJson = (res.headers.get('content-type') ?? '').includes('json')
  // 501 (the composition lacks the feature) and 503 (no browser is
  // connected, the GC scan is incomplete) are declared refusals with
  // a JSON reason; anything else at or above 500 is a stack trace.
  expect(res.status === 501 || res.status === 503 || res.status < 500, detail).toBe(true)
  if (res.status >= 300 && res.status < 400) return judgeRedirect(rule, res, detail)
  judgeKind(rule, res, isJson, text, detail)
  if (res.status >= 400 && isJson) judgeRefusal(res, text, detail)
  if (res.status >= 300) return false
  if ('response' in rule && rule.response !== undefined && isJson) {
    const read = rule.response.safeParse(JSON.parse(text))
    expect(read.success, `${detail}\n${JSON.stringify(read.error?.issues)}`).toBe(true)
  }
  return true
}

function requestInit(method: string, rule: Rule, target: Target, body: Body | undefined) {
  const headers: Record<string, string> = { ...target.headers }
  const init: RequestInit = { method, headers }
  if (body?.kind === 'bytes') {
    init.body = new Uint8Array(body.bytes)
    headers['content-type'] =
      ('contentType' in rule ? rule.contentType : undefined) ?? 'application/octet-stream'
  } else if (body !== undefined) {
    init.body = body.kind === 'json' ? JSON.stringify(body.json) : body.text
    headers['content-type'] = 'application/json'
  }
  return init
}

/** One request against the composition, judged; true when it was answered. */
async function exercise(
  harness: Harness,
  key: string,
  rule: Rule,
  { target, body }: { target: Target; body: Body | undefined },
): Promise<boolean> {
  const method = key.split(' ')[0] as string
  const init = requestInit(method, rule, target, body)
  const res = await harness.request(target.path, init)
  const contentType = res.headers.get('content-type') ?? ''
  const text = contentType.includes('json') || !contentType ? await res.text() : ''
  const sent = init.body instanceof Uint8Array ? '<bytes>' : (init.body ?? '')
  const detail = `${method} ${target.path} ${sent} -> ${res.status} ${contentType} ${res.headers.get('location') ?? ''} ${text.slice(0, 200)}`
  return judge(rule, res, text, detail)
}

/** One row per rule: a fresh seeded composition, then `numRuns` requests drawn against it. */
export function fuzzRows(
  rules: Record<string, Rule>,
  answered: Map<string, number>,
  seeded: () => Promise<Harness>,
): void {
  for (const [key, rule] of Object.entries(rules)) {
    if ('skip' in rule) continue
    const [method, pattern] = key.split(' ') as [string, string]
    const runs = 'runs' in rule && rule.runs !== undefined ? rule.runs : 40
    // A ceiling sized on a measurement, not a delay: 40 requests take 0.2-2s
    // on this container, and a render route's 24 draws took 19-21s — past
    // the project's 10s default, and a timed-out test keeps rendering into
    // the next test's fresh database, which then answers SQLITE_BUSY.
    const ceilingMs = 'runs' in rule && rule.runs !== undefined ? 90_000 : 30_000
    fcTest.prop([fc.constant(null)], withDefaults({ numRuns: 1 }))(
      `${key}`,
      async () => {
        const harness = await seeded()
        try {
          const requestArb = fc.record({
            target: harness.target(key, pattern),
            body: bodyArb(method, rule, harness.override),
          })
          await fc.assert(
            fc.asyncProperty(requestArb, async (request) => {
              if (await exercise(harness, key, rule, request)) {
                answered.set(key, (answered.get(key) ?? 0) + 1)
              }
            }),
            withDefaults({ numRuns: runs }),
          )
        } finally {
          await harness.dispose()
        }
      },
      ceilingMs,
    )
  }
}

/** The ledger: a row marked to answer that never did probed nothing, and a refuses-only row that answered is stale. */
export function assertLedger(rules: Record<string, Rule>, answered: Map<string, number>): void {
  const silent: string[] = []
  const loud: string[] = []
  for (const [key, rule] of Object.entries(rules)) {
    const count = answered.get(key) ?? 0
    if ('answers' in rule && count === 0) silent.push(key)
    if ('refusesOnly' in rule && count > 0) loud.push(key)
  }
  expect(
    silent,
    `routes this lane never got an answer from: ${JSON.stringify([...answered])}`,
  ).toEqual([])
  expect(loud, 'routes marked refuses-only that answered').toEqual([])
}
