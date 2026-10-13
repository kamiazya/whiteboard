/**
 * A client names a daemon route in ONE place: daemon-client's URL builders
 * (`api-contracts/daemon-urls.ts`, and `document-url.ts` beside its parser).
 * This scan is the executable half of that rule.
 *
 * The builders are what mcp-server's `daemon-client-urls.routes.test.ts`
 * requests against the real app, so a route renamed on either side fails
 * there. A path spelled by hand anywhere else is invisible to it: renaming the
 * server's route for one leaves every client and server test green, because
 * the client's own tests assert the client's own literal.
 *
 * It reads shipped client code — `apps/web/src`, `apps/extension/src` and
 * `packages/daemon-client/src` — with comments removed, and fails on a string
 * or template literal that writes an `/api/` or `/auth/` path: one that opens
 * on the quote, or follows an interpolation (`${base}/api/…`), which is how a
 * path prefixed with a daemon base URL is spelled.
 *
 * The ledger is guarded from both sides like every allowlist here: an entry
 * whose literal is gone fails as stale.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'
import { stripComments } from './strip-comments.js'

const CLIENT_ROOTS = ['apps/web/src', 'apps/extension/src', 'packages/daemon-client/src']

/** Where a route is named, and so where a route literal belongs. */
const HOMES: readonly string[] = [
  'packages/daemon-client/src/api-contracts/daemon-urls.ts',
  'packages/daemon-client/src/api-contracts/document-url.ts',
]

interface Exemption {
  readonly file: string
  /** The literal path as written, up to its first interpolation or quote. */
  readonly literal: string
  readonly why: string
}

const LEDGER: readonly Exemption[] = [
  {
    file: 'packages/daemon-client/src/sse-stream-hub.ts',
    literal: '/api/sync/message',
    why: "the sync protocol's endpoints, which the hub alone requests; mcp-server's web-api-paths-mounted test holds the quoted two to a mounted route",
  },
  {
    file: 'packages/daemon-client/src/sse-stream-hub.ts',
    literal: '/api/sync/subscribe',
    why: 'the sync protocol, as above',
  },
  {
    file: 'packages/daemon-client/src/sse-stream-hub.ts',
    literal: '/api/sync/stream',
    why: 'the sync protocol, as above; written after the base URL, so web-api-paths-mounted does not read it',
  },
  {
    file: 'packages/daemon-client/src/api-client.ts',
    literal: '/api/',
    why: 'a same-origin prefix check (`startsWith`), never a request',
  },
  {
    file: 'packages/daemon-client/src/extension-bridge.ts',
    literal: '/api/',
    why: 'the bridge refuses any path outside `/api/` (`startsWith`); a prefix check, never a request',
  },
]

/** A route literal: opening on a quote or backtick, or right after a `${…}`. */
const ROUTE_LITERAL = /(?<=['"`}])\/(?:api|auth)\/[^'"`$\s]*/g

function routeLiterals(source: string): string[] {
  return [...stripComments(source).matchAll(ROUTE_LITERAL)].map(([hit]) => hit)
}

const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')

const files = CLIENT_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root)))
  .filter((path) => isShippedPath(path))
  .map(relOf)

const hits = files.flatMap((file) =>
  routeLiterals(readFileSync(join(REPO_ROOT, file), 'utf8')).map((literal) => ({
    file,
    literal,
  })),
)

const exempt = (hit: { file: string; literal: string }) =>
  HOMES.includes(hit.file) ||
  LEDGER.some((entry) => entry.file === hit.file && entry.literal === hit.literal)

describe('a client names a daemon route only through the URL builders', () => {
  it('scans the client trees and finds the builders it holds them to', () => {
    expect(files.length).toBeGreaterThan(300)
    for (const root of CLIENT_ROOTS) expect(files.some((file) => file.startsWith(root))).toBe(true)
    // The homes are where the routes are; a count far below what they hold
    // means the pattern stopped matching, not that the clients got cleaner.
    expect(hits.filter((hit) => HOMES.includes(hit.file)).length).toBeGreaterThan(10)
  })

  it('no shipped client module spells an /api/ or /auth/ path itself', () => {
    const offenders = hits.filter((hit) => !exempt(hit)).map((hit) => `${hit.file}: ${hit.literal}`)
    expect(
      offenders,
      'build the URL with a builder from @kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls (or document-url); add one there, with its entry in daemon-client-urls.routes.test.ts, if the route has none',
    ).toEqual([])
  })

  it('every ledger entry still matches a literal, and every home still holds one', () => {
    const stale = LEDGER.filter(
      (entry) => !hits.some((hit) => hit.file === entry.file && hit.literal === entry.literal),
    ).map((entry) => `${entry.file}: ${entry.literal}`)
    expect(stale).toEqual([])
    expect(HOMES.filter((home) => !hits.some((hit) => hit.file === home))).toEqual([])
  })

  it('reads a quoted path, and a path after an interpolation', () => {
    expect(routeLiterals("fetch('/api/runtime/ping')")).toEqual(['/api/runtime/ping'])
    expect(routeLiterals(`fetch(\`\${base}/api/w/\${id}/document\`)`)).toEqual(['/api/w/'])
    expect(routeLiterals('const u = "/auth/session"')).toEqual(['/auth/session'])
  })

  it('does not read a comment, a regex or a foreign URL as a route literal', () => {
    expect(routeLiterals("// fetch('/api/runtime/ping')\nconst x = 1")).toEqual([])
    expect(routeLiterals('/** `/api/v1` is served by server-core */\nconst x = 1')).toEqual([])
    expect(routeLiterals('const re = /\\/api\\//')).toEqual([])
    expect(routeLiterals("const u = 'https://example.com/api/x'")).toEqual([])
  })
})
