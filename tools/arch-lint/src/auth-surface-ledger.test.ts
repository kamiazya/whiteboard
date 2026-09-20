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
 * `routes/ws-ticket.ts` were found by the confinement scan on its first run.
 * Of those three, `runtime.ts` had no macaroon branch — so the route-scope
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
import { isTestPath, walkSourceFiles } from './source-scan.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const SCAN_DIR = 'packages/mcp-server/src'

/** A surface asks the resolver what a credential carries… */
const RESOLVES = /(?:credentialResolver|resolver)\s*\??\.\s*resolve\s*\(/
/** …or, in server-mode, asks its own external-IdP strategy. */
const OWN_STRATEGY = /authStrategy\.authorize\s*\(/

type SurfacePolicy =
  /** Resolves through `credential-resolver.ts`; the text is what it then DECIDES. */
  | `resolver: ${string}`
  /** Server-mode's own strategy; the text says why it is not the resolver's. */
  | `own-strategy: ${string}`

const AUTH_SURFACES = {
  'packages/mcp-server/src/server/routes/auth.ts':
    'resolver: /api/*. Full authority passes without consulting the registry; every narrower grant goes through `grantCoversRoute`, which fails closed on an undeclared route and refuses `daemon-token-only` outright.',

  'packages/mcp-server/src/server/routes/runtime.ts':
    'resolver: /api/runtime/*. STRICTER than /api/* on purpose — a narrow credential reaches only routes declaring `runtime:read`, whatever scopes it holds, so a grant carrying `runtime:admin` still cannot reach shutdown. The logs-prune handler re-checks by KIND for its own file-deleting reason.',

  'packages/mcp-server/src/server/routes/ws-auth.ts':
    'resolver: the websocket upgrade. NO scope policy here by design — `routes/ws.ts` enforces per operation against `ws-scope-registry.ts`, so the handshake only establishes the grant and hands its scopes along. Two lanes: a single-use ticket, and everything else on the daemon-token subprotocol carrier.',

  'packages/mcp-server/src/server/security/mcp-auth.ts':
    'resolver: /mcp in local-daemon mode. Full authority passes; an OAuth grant or a macaroon passes iff it carries `mcp:call`, the same scope server-mode enforces on this route. A pairing token is refused as a DECISION rather than on scopes (it holds them all today) — a paired browser origin speaks `/api/*`, not MCP. A verified credential this surface will not admit gets 403 without a challenge.',

  'packages/mcp-server/src/server/routes/debug.ts':
    'resolver: /api/debug, mounted only when the debug endpoint is enabled. Judged by KIND — a dump of live document state is not something a narrow credential gets, however wide its scope set.',

  'packages/mcp-server/src/server/routes/ws-ticket.ts':
    'resolver: POST /api/ws-ticket. Judged by KIND, and only `oauth-grant` mints: a ticket exists to bridge an OAuth grant onto the websocket, so it needs WHICH grant is asking, not merely that someone may act. The daemon token has never minted one.',

  'packages/mcp-server/src/server/routes/replica-key.ts':
    "resolver: POST /api/workspaces/:workspaceId/replica-key. `anonymous`/`daemon-token` bypass membership entirely (already full authority over the data this key decrypts); every other grant must carry a PASSKEY BINDING (`grant.passkey`), which only the `pairing` kind ever sets — the registry's `workspace:read` scope alone is not enough, an OAuth grant holding it is refused with no binding to check.",

  'packages/mcp-server/src/server/security/server-mode-middleware.ts':
    'own-strategy: server-mode validates a JWT against an external IdP, so there is no credential this daemon issued to resolve. Folding it into the resolver is a separate increment with its own review; what it shares today is the scope vocabulary and the route-scope registry.',
} satisfies Record<string, SurfacePolicy>

function scan(): { readonly surfaces: string[]; readonly fileCount: number } {
  const files: string[] = []
  walkSourceFiles(join(REPO_ROOT, SCAN_DIR), files)
  const surfaces: string[] = []
  let fileCount = 0
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    if (isTestPath(rel)) continue
    fileCount += 1
    const source = readFileSync(file, 'utf8')
    if (RESOLVES.test(source) || OWN_STRATEGY.test(source)) surfaces.push(rel)
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
  // deliberately rather than watching one drift. Eight, since the read
  // plane's replica-key route (ADR-0042 decisions 1/3/5) added a surface.
  it('holds the surface count at eight', () => {
    expect(scan().surfaces).toHaveLength(8)
  })
})
