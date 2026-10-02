/**
 * Which of `mcp-server`'s HTTP routes could run somewhere other than Node.
 *
 * `server-core` holds the routes a second composition root can mount through
 * `createServer(deps)`. Everything under `packages/mcp-server/src/server/routes`
 * is where this root keeps the rest, and a route there is one of two things:
 *
 * - NODE-BOUND: it imports a Node builtin, a Node-only package, inversify, a
 *   storage or housekeeping mechanic of this root, or anything else the
 *   boundary scanner flags. Moving it means first replacing what it touches.
 * - PORTABLE: it imports none of those directly. Written against hono, the
 *   contracts and the seams it is handed, it would run in a Worker unchanged,
 *   yet it sits in the one package whose job is to be Node.
 *
 * The second class is the one worth a number. A portable route in `mcp-server`
 * is a route a keeper that is not this daemon has to write again, which is the
 * divergence ADR-0018 records for operations and ADR-0052 now runs into for the
 * sync protocol a browser speaks. This scan states how many there are, names
 * them, and lets the number only fall.
 *
 * DIRECT imports only. A portable route still reaches a mechanic through the
 * helpers it calls (`workspace-handle`, `../log.js`, the security gates), and
 * those travel with it when it is lifted; this is the count of routes whose OWN
 * source is free of Node, which is the lower bound on the work and the
 * necessary condition for any move.
 *
 * It does not use `adapter-mechanic-check`'s matcher: that one asks whether an
 * adapter reaches a mechanic and answers with an edge ledger, this one asks
 * whether a file could leave Node and answers with a class. Each fails alone.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, walk } from './scan-roots.js'
import { collectModuleSpecifiers, scanSourceForBoundaryViolations } from './scanner.js'

const ROUTES_DIR = join(REPO_ROOT, 'packages/mcp-server/src/server/routes')

/** A relative import that lands in this root's own mechanics or composition. */
const NODE_BOUND_LOCAL =
  /^\.\.?\/(?:.*\/)?(?:(?:store|daemon|di|export)\/|security\/[a-z0-9-]+-store\.js$|tenant\/data-layout\.js$|mcp\/index\.js$)/

/**
 * Packages that only run on Node. `@hono/node-server` binds hono to Node's http
 * module and `pino` writes through Node streams. A list rather than a rule
 * because a package's runtime support is a fact about the package; the portable
 * ledger below is what notices when one is missing here.
 */
const NODE_ONLY_PACKAGES = ['@hono/node-server', 'pino', 'kysely', '@libsql/client'] as const

function isNodeOnlyPackage(specifier: string): boolean {
  return NODE_ONLY_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

/** Why a file is node-bound; empty when it is portable. */
function nodeBoundReasons(fileName: string, source: string): string[] {
  const reasons = new Set<string>()
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  for (const { specifier } of collectModuleSpecifiers(sourceFile)) {
    if (NODE_BOUND_LOCAL.test(specifier) || isNodeOnlyPackage(specifier)) {
      reasons.add(`imports ${specifier}`)
    }
  }
  for (const { kind, name } of scanSourceForBoundaryViolations(fileName, source)) {
    // loro-crdt is shared-layer by design and runs on every runtime.
    if (kind !== 'loro-crdt-import') reasons.add(`${kind} ${name}`)
  }
  return [...reasons].sort()
}

const isRouteSource = (file: string): boolean =>
  file.endsWith('.ts') && !file.endsWith('.test.ts') && !/(^|[\\/])_test-/.test(file)

function classifyAll(dir: string): { portable: string[]; nodeBound: string[] } {
  const portable: string[] = []
  const nodeBound: string[] = []
  for (const file of walk(dir, { include: isRouteSource })) {
    const name = relative(dir, file).split('\\').join('/')
    const reasons = nodeBoundReasons(file, readFileSync(file, 'utf8'))
    ;(reasons.length === 0 ? portable : nodeBound).push(name)
  }
  return { portable: portable.sort(), nodeBound: nodeBound.sort() }
}

/**
 * The portable routes that still sit in `mcp-server`, relative to `routes/`.
 *
 * Guarded from both sides: a portable route missing from here fails as
 * unlisted, and an entry that is no longer a portable route (gone, lifted into
 * `server-core`, or now importing Node) fails as stale. Whether lifting them is
 * the right move is ADR-0052's open decision, and nothing here decides it.
 */
const PORTABLE_ROUTES_IN_MCP_SERVER: readonly string[] = [
  'auth.ts',
  'body-limit.ts',
  'document-output-path-error.ts',
  'document/live-doc.ts',
  'document/path-route.ts',
  'document/restore.ts',
  'document/trash.ts',
  'document/workspaces.ts',
  'status.ts',
  'sync-audience.ts',
  'viewport-requests.ts',
  'workspace-people.ts',
]

/**
 * How many entries the ledger may hold, pinned by equality: adding a portable
 * route fails until this is raised on the record, and lifting one fails until
 * it is lowered, so the number keeps saying where the lift stands. The same
 * shape as `ADAPTERS_REACHING_MECHANICS_CEILING`.
 */
const PORTABLE_ROUTES_CEILING = 12

function ledgerDrift(
  portable: readonly string[],
  ledger: readonly string[],
): { unlisted: string[]; stale: string[] } {
  const listed = new Set(ledger)
  const found = new Set(portable)
  return {
    unlisted: portable.filter((name) => !listed.has(name)),
    stale: ledger.filter((name) => !found.has(name)),
  }
}

describe('what makes a route node-bound', () => {
  const reasonsOf = (source: string) => nodeBoundReasons('route.ts', source)

  it('calls a route that imports only hono and its contracts portable', () => {
    expect(
      reasonsOf(
        "import { Hono } from 'hono'\nimport { z } from 'zod'\nimport { loro } from 'loro-crdt'\nexport const r = new Hono()\n",
      ),
    ).toEqual([])
  })

  it.each([
    ['a Node builtin', "import { readFile } from 'node:fs/promises'\nexport const x = readFile\n"],
    ['inversify', "import { inject } from 'inversify'\nexport const x = inject\n"],
    [
      'a store module',
      "import { getDoc } from '../store/document-store.js'\nexport const x = getDoc\n",
    ],
    ['a nested store module', "import { q } from '../../store/db/query.js'\nexport const x = q\n"],
    [
      'a people store',
      "import type { S } from '../security/invitation-store.js'\nexport type X = S\n",
    ],
    ['the data layout', "import { root } from '../tenant/data-layout.js'\nexport const x = root\n"],
    [
      'the export keeper',
      "import { run } from '../export/headless-export.js'\nexport const x = run\n",
    ],
    ['the di graph', "import { c } from '../di/container.js'\nexport const x = c\n"],
    [
      'a Node-only package',
      "import { getConnInfo } from '@hono/node-server/conninfo'\nexport const x = getConnInfo\n",
    ],
    ['a dynamic import of a mechanic', "export const x = () => import('../store/doc-cache.js')\n"],
    ['a process global', 'export const x = process.env.HOME\n'],
  ])('calls a route that reaches %s node-bound', (_name, source) => {
    expect(reasonsOf(source)).not.toEqual([])
  })

  it('does not take the seam or the security policy modules for mechanics', () => {
    expect(
      reasonsOf(
        "import type { DataLayout } from '../tenant/data-layout-seam.js'\nimport { gate } from '../security/membership-gate.js'\nexport const x = [gate]\n",
      ),
    ).toEqual([])
  })
})

describe('the portable-route ledger notices drift from both sides', () => {
  it('reports a portable route that is not listed, and a listed one that is not portable', () => {
    expect(ledgerDrift(['a.ts', 'b.ts'], ['b.ts', 'c.ts'])).toEqual({
      unlisted: ['a.ts'],
      stale: ['c.ts'],
    })
  })
})

describe('mcp-server routes that could run somewhere other than Node', () => {
  const { portable, nodeBound } = classifyAll(ROUTES_DIR)

  // A walk that found nothing, or a classifier that put everything in one
  // class, would pass every assertion below while checking nothing.
  it('classifies the real route tree into both classes', () => {
    expect(portable.length + nodeBound.length).toBeGreaterThan(25)
    expect(portable.length).toBeGreaterThan(5)
    expect(nodeBound.length).toBeGreaterThan(5)
  })

  it('lists every portable route that sits in mcp-server', () => {
    expect(
      ledgerDrift(portable, PORTABLE_ROUTES_IN_MCP_SERVER).unlisted,
      'a route under mcp-server/src/server/routes imports nothing Node-bound, so a ' +
        'keeper that is not this daemon would write it again. Put it in server-core ' +
        'behind a seam, or list it in PORTABLE_ROUTES_IN_MCP_SERVER and raise the ceiling.',
    ).toEqual([])
  })

  it('lists no route that has stopped being a portable one', () => {
    expect(
      ledgerDrift(portable, PORTABLE_ROUTES_IN_MCP_SERVER).stale,
      'these entries are gone, lifted into server-core, or now import something ' +
        'Node-bound — delete them and lower PORTABLE_ROUTES_CEILING.',
    ).toEqual([])
  })

  it('holds the ledger at its declared ceiling', () => {
    expect(
      PORTABLE_ROUTES_IN_MCP_SERVER.length,
      PORTABLE_ROUTES_IN_MCP_SERVER.length > PORTABLE_ROUTES_CEILING
        ? 'a portable route was added to mcp-server. Lift it, or raise the ceiling in the same diff and say why.'
        : 'a route was lifted or went node-bound — lower PORTABLE_ROUTES_CEILING to match.',
    ).toBe(PORTABLE_ROUTES_CEILING)
  })
})
