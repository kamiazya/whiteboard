// Every `/api/...` path apps/web asks for must be a route the daemon mounts.
//
// Nothing checked this, and the gap was live: `StorageReportCard` fetched
// `/api/user-libraries` and offered a Remove button posting DELETE to
// `/api/user-libraries/:name`, for a feature whose server half had been
// deleted with the move to the document model. Both could only ever 404. The
// component's own comment acknowledged the contract was gone and redefined
// the request schema locally rather than following it, so the client kept
// calling a route that no longer existed.
//
// Its tests could not catch it: they mock `fetchApi`, so they assert the
// client against a server that answers whatever the fixture says. That is the
// right thing for a component test to do and the reason this guard has to
// live somewhere else — against the routes the daemon really mounts.
//
// Reading apps/web source from this package follows web-app-boundary.test.ts:
// the daemon owns the contract, so the daemon's suite is where a client's
// use of it is checked.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import { createApp } from '../app.js'
import { DOCUMENT_WILDCARD, DOCUMENTS_WILDCARD } from '../routes/document/path-route.js'
import { createDaemonIdentity } from '../security/daemon-identity.js'
import { createPairingGrantStore } from '../security/pairing-grant-store.js'
import { createPairingCodeStore, createPairingTokenStore } from '../security/pairing-session.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')
const WEB_SRC = join(ROOT, 'apps/web/src')

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-api-paths-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * Paths a literal can carry that are not a request target.
 *
 * Kept tiny and each one reasoned about — an exclusion list is how a guard
 * stops reaching its subject. `/api/...` is prose inside a doc comment;
 * `/api/v1` is a prefix a caller concatenates onto, never fetched whole.
 */
const NOT_A_REQUEST_TARGET = new Set(['/api/...', '/api/v1'])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** `${...}` interpolations and `:name` segments both stand for one segment. */
function normalize(path: string): string {
  return path
    .replace(/\$\{[^}]*\}/g, ':p')
    .replace(/:[A-Za-z_][\w]*/g, ':p')
    .replace(/\/+$/, '')
}

interface WebPath {
  raw: string
  normalized: string
  file: string
}

function webApiPaths(): WebPath[] {
  const seen = new Map<string, WebPath>()
  for (const file of sourceFiles(WEB_SRC)) {
    const text = readFileSync(file, 'utf-8')
    // All three quotings, matched with a backreference so the closing quote is
    // the opening one. Double quotes are not hypothetical here: biome.json sets
    // `jsxQuoteStyle: "double"`, so a JSX `src="/api/…"` is the style the
    // linter ENFORCES — a scan blind to it would miss the one place a path is
    // most likely to be written inline.
    for (const match of text.matchAll(/(['"`])(\/api\/[^'"`]*)\1/g)) {
      const raw = match[2]
      if (NOT_A_REQUEST_TARGET.has(raw)) continue
      // A literal broken across an interpolation boundary is not a whole path.
      if (raw.includes('${') && !raw.includes('}')) continue
      const normalized = normalize(raw)
      if (!seen.has(normalized)) {
        seen.set(normalized, { raw, normalized, file: file.replace(`${ROOT}/`, '') })
      }
    }
  }
  return [...seen.values()]
}

/**
 * Every /api route the daemon can mount, across BOTH supported modes.
 *
 * Neither mode alone is the surface: `/api/v1` mounts only when ServerDeps are
 * supplied (server-mode), and `/api/pairing` only under local-daemon with
 * pairing stores. A guard built on one mode would report the other's routes as
 * missing — which is the same failure as not checking at all, only louder and
 * wrong. The reach assertions below pin that both halves are present.
 */
function mountedApiRoutes(): string[] {
  const serverMode = createApp({
    authMode: 'server-mode',
    publicBaseUrl: 'https://example.com',
    allowedOrigins: ['https://example.com'],
    authStrategy: () => ({ ok: false as const, status: 401 as const, error: 'denied' }),
    touch: () => {},
    getStatus: () => ({}) as never,
    shutdown: () => Promise.resolve(),
    serverDeps: resolveServerDeps(createContainer()),
  })

  const pairingDir = tempDir()
  const localDaemon = createApp({
    authMode: 'local-daemon',
    token: 'test-token',
    publicBaseUrl: 'http://127.0.0.1:3099',
    allowedOrigins: ['http://127.0.0.1:3099'],
    touch: () => {},
    getStatus: () => ({}) as never,
    shutdown: () => Promise.resolve(),
    identity: createDaemonIdentity({ dataDir: pairingDir }),
    pairing: {
      grants: createPairingGrantStore(pairingDir),
      codes: createPairingCodeStore(),
      tokens: createPairingTokenStore(),
    },
  })

  return [
    ...new Set(
      [...serverMode.routes, ...localDaemon.routes]
        .map((route) => route.path)
        .filter((path) => path.startsWith('/api/')),
    ),
  ]
}

/**
 * The only mounted patterns whose `*` really serves the paths beneath it.
 *
 * Hono's `app.routes` gives middleware registered with `app.use(pattern)` and
 * endpoints the same shape, so a wildcard entry is not evidence of a mount
 * that serves anything. Most of them are middleware: `/api/*` is the auth and
 * host-guard chain over the whole API, `/api/runtime/*` a runtime guard, and
 * `/api/v1/workspaces/:workspaceId/*` server-core's own `app.use` — the v1
 * endpoints beneath it are listed concretely and match on their own.
 *
 * What is left is the two path-addressed document patterns, where the
 * wildcard IS the endpoint mechanism because a document path is many
 * segments. They are imported rather than restated: a copy here is a second
 * list to keep in step, which is the defect this guard exists for.
 *
 * Treating any other wildcard as a mount is not a small error. `/api/*` covers
 * the entire API, so accepting it makes EVERY path resolve — a guard that
 * cannot fail, reading exactly like one that checked. The first version of
 * this file did precisely that (its `/api/*` case sat after the wildcard
 * branch, unreachable) and reported `/api/user-libraries` as mounted. The
 * control cases below are what catch that class; reading the function again
 * is not.
 */
const WILDCARD_ENDPOINTS = [DOCUMENT_WILDCARD, DOCUMENTS_WILDCARD].map(normalize)

function isMounted(webPath: string, routes: readonly string[]): boolean {
  return routes.some((route) => {
    const pattern = normalize(route)
    if (pattern.endsWith('/*')) {
      if (!WILDCARD_ENDPOINTS.includes(pattern)) return false
      return webPath.startsWith(pattern.slice(0, -1))
    }
    return pattern === webPath
  })
}

describe('apps/web only asks for /api routes the daemon mounts', () => {
  const routes = mountedApiRoutes()
  const paths = webApiPaths()

  // Both scans are asserted to reach their subject first. A scan that stops
  // matching reports every path as fine, which is the shape of a pass.
  it('finds the routes the daemon mounts, in both modes', () => {
    expect(routes.length).toBeGreaterThan(20)
    expect(routes.some((route) => route.startsWith('/api/v1/'))).toBe(true)
    expect(routes.some((route) => route.startsWith('/api/pairing'))).toBe(true)
  })

  it('finds the paths apps/web asks for', () => {
    expect(paths.length).toBeGreaterThan(8)
  })

  // The matcher's own control. Everything above can be right while `isMounted`
  // answers true for anything, and then the assertion below passes over a real
  // defect. A path no route serves must come back unmounted.
  it('every wildcard endpoint it trusts is actually mounted', () => {
    const mounted = routes.map(normalize)
    expect(WILDCARD_ENDPOINTS.filter((pattern) => !mounted.includes(pattern))).toEqual([])
  })

  it('does not report an unserved path as mounted', () => {
    expect(isMounted('/api/definitely-not-a-route', routes)).toBe(false)
    expect(isMounted('/api/runtime/not-a-real-endpoint', routes)).toBe(false)
  })

  it('every one of them resolves', () => {
    const unmounted = paths.filter((path) => !isMounted(path.normalized, routes))
    expect(
      unmounted.map((path) => `${path.raw} (${path.file})`),
      'apps/web requests a route the daemon does not mount',
    ).toEqual([])
  })
})
