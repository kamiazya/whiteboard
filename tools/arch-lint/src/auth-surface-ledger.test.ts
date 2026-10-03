/**
 * Every place the daemon gates a request on a credential, classified.
 *
 * The companion scan (`credential-verification-check.test.ts`) confines
 * VERIFICATION to one module. It cannot notice a new SURFACE: a file that
 * resolves a credential correctly, through the right component, and then
 * invents its own policy — or forgets one. That is the direction this ledger
 * covers, and the reason it exists is measured rather than supposed.
 *
 * The work that built the resolver started from a hand-written survey of
 * "four auth surfaces". There were SEVEN. `routes/runtime.ts` was found by a
 * typecheck error after a truncated grep dropped it; `routes/debug.ts` and
 * a since-deleted websocket-ticket route were found by the confinement scan
 * on its first run. Of those three, `runtime.ts` had no macaroon branch — so the route-scope
 * registry said `runtime:read` opened `/api/runtime/storage`, the global gate
 * agreed, and the inner middleware refused. Nothing was red, because a
 * surface that quietly admits less than the registry declares fails closed.
 *
 * So the rule is not "every surface admits everything" — the policies really
 * do differ, deliberately, and each entry below says how. The rule is that a
 * surface cannot arrive without an answer.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { credentialGateCalls } from './auth-surface-scan.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const SCAN_DIR = 'packages/mcp-server/src'

type SurfacePolicy =
  /** Resolves through `credential-resolver.ts`; the text is what it then DECIDES. */
  | `resolver: ${string}`
  /** Server-mode's own strategy; the text says why it is not the resolver's. */
  | `own-strategy: ${string}`
  /** Hands the decision to a classified surface and adds none of its own. */
  | `delegate: ${string}`

const AUTH_SURFACES = {
  'packages/mcp-server/src/server/routes/auth.ts':
    'resolver: /api/*. Full authority passes without consulting the registry; every narrower grant goes through `grantCoversRoute`, which fails closed on an undeclared route and refuses `daemon-token-only` outright.',

  'packages/mcp-server/src/server/routes/runtime.ts':
    'resolver: /api/runtime/*. STRICTER than /api/* on purpose — a narrow credential reaches only routes declaring `runtime:read`, whatever scopes it holds, so a grant carrying `runtime:admin` still cannot reach shutdown.',

  'packages/mcp-server/src/server/security/mcp-auth.ts':
    'resolver: /mcp in local-daemon mode. Full authority passes; a macaroon passes iff it carries `mcp:call`, the same scope server-mode enforces on this route. A verified credential this surface will not admit gets 403 without a challenge.',

  'packages/mcp-server/src/server/routes/debug.ts':
    'resolver: /api/debug, mounted only when the debug endpoint is enabled. Judged by KIND — a dump of live document state is not something a narrow credential gets, however wide its scope set.',

  'packages/mcp-server/src/server/security/server-mode-middleware.ts':
    'own-strategy: server-mode validates a JWT against an external IdP, so there is no credential this daemon issued to resolve. Folding it into the resolver is a separate increment with its own review; what it shares today is the scope vocabulary and the route-scope registry.',

  'packages/mcp-server/src/server/security/mcp-http.ts':
    'delegate: /mcp in local-daemon mode. The Hono middleware over the `McpHttpAuthStrategy` it is handed: it forwards the method and Authorization header and answers the status and challenge the decision carries. Every policy decision is `mcp-auth.ts`, classified above.',
} satisfies Record<string, SurfacePolicy>

/** Whether a source text gates on a credential, and the ledger has no answer for it. */
function unclassifiedSurface(rel: string, source: string): boolean {
  return credentialGateCalls(rel, source).length > 0 && !(rel in AUTH_SURFACES)
}

function scan(): { readonly surfaces: string[]; readonly fileCount: number } {
  const files: string[] = []
  walkSourceFiles(join(REPO_ROOT, SCAN_DIR), files)
  const surfaces: string[] = []
  let fileCount = 0
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    if (isTestPath(rel)) continue
    fileCount += 1
    if (credentialGateCalls(rel, readFileSync(file, 'utf8')).length > 0) surfaces.push(rel)
  }
  return { surfaces: surfaces.sort(), fileCount }
}

describe('every auth surface answers for itself', () => {
  // A count, because a walk that stops finding files reports itself as
  // "every surface is classified" and sends the reader nowhere.
  it('scans a plausible number of production files', () => {
    expect(scan().fileCount).toBeGreaterThan(200)
  })

  it('classifies every surface that gates on a credential', () => {
    const unclassified = scan().surfaces.filter((file) => !(file in AUTH_SURFACES))

    expect(
      unclassified,
      'A new place gates a request on a credential and has no entry in AUTH_SURFACES. Say what it admits and why — the survey that missed three of these was written by hand, and one of the three quietly admitted less than the route-scope registry declared, with nothing red.',
    ).toEqual([])
  })

  it('names no surface that has stopped gating', () => {
    const { surfaces } = scan()
    const stale = Object.keys(AUTH_SURFACES).filter((file) => !surfaces.includes(file))

    expect(
      stale,
      'AUTH_SURFACES names a file that no longer resolves a credential. Drop the entry — a ledger describing surfaces that are gone stops describing the ones that are here.',
    ).toEqual([])
  })

  // The count IS the finding. Seven was a surprise to the person who had just
  // refactored all of them, so it is worth a reader having to change a number
  // deliberately rather than watching one drift. Five, since ADR-0050 took
  // the local daemon off loopback TCP and its browser-facing surfaces (the
  // websocket, its ticket, and the replica-key route's passkey binding) went;
  // six once the scan stopped keying on a receiver's name and saw
  // `security/mcp-http.ts`, the middleware that forwards to `mcp-auth.ts`.
  it('holds the surface count at six', () => {
    expect(scan().surfaces).toHaveLength(6)
  })
})

describe('the scan keys on what a file is handed, not on what it calls it', () => {
  const HEAD = "import type { CredentialResolver } from '../security/credential-resolver.js'\n"
  const STRATEGY_HEAD = "import type { McpHttpAuthStrategy } from '../security/mcp-auth.js'\n"

  it.each([
    [
      'a resolver-typed parameter under another name',
      `${HEAD}export async function gate(credentials: CredentialResolver, h: string) {\n  return credentials.resolve({ authorizationHeader: h })\n}`,
    ],
    [
      'a destructured resolve',
      `${HEAD}export async function gate(r: CredentialResolver, h: string) {\n  const { resolve } = r\n  return resolve({ authorizationHeader: h })\n}`,
    ],
    [
      'a strategy under another name',
      `${STRATEGY_HEAD}export async function gate(strategy: McpHttpAuthStrategy, h: string) {\n  return strategy.authorize({ method: 'POST', authorizationHeader: h })\n}`,
    ],
    [
      'a string-key call',
      `${HEAD}export async function gate(r: CredentialResolver, h: string) {\n  return r['resolve']({ authorizationHeader: h })\n}`,
    ],
  ])('flags %s as unclassified', (_label, source) => {
    expect(unclassifiedSurface('packages/mcp-server/src/server/routes/zz-surface.ts', source)).toBe(
      true,
    )
  })

  it.each([
    [
      'a path resolve in a file handed no gate type',
      "import { resolve } from 'node:path'\nexport const f = (p: string) => resolve(p)",
    ],
    [
      'a promise executor beside a gate type',
      `${HEAD}export const wait = (r: CredentialResolver) => new Promise<void>((resolve) => { void r; resolve() })`,
    ],
    [
      'Promise.resolve beside a gate type',
      `${HEAD}export const done = (r: CredentialResolver) => { void r; return Promise.resolve() }`,
    ],
  ])('does not flag %s', (_label, source) => {
    expect(unclassifiedSurface('packages/mcp-server/src/server/routes/zz-surface.ts', source)).toBe(
      false,
    )
  })

  it('accepts a surface the ledger answers for', () => {
    const source = `${HEAD}export const gate = (c: CredentialResolver) => c.resolve({})`
    expect(unclassifiedSurface('packages/mcp-server/src/server/routes/auth.ts', source)).toBe(false)
  })
})
