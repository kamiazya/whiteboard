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
 * Two readings, and the second is the one that counts. The CLASS above is
 * judged on a file's OWN imports, which is a necessary condition for any move
 * and a poor measure of one: a portable route reaches Node through the helpers
 * it calls (`../log.js`, `workspace-handle`, the security gates), and a
 * `node:fs` planted in `validators.ts` — imported by three of them — left the
 * direct scan green. So each ledgered file is also classified over the
 * transitive closure of its VALUE imports, with two named cut seams (the Node
 * logger and the store-backed workspace handle) that a lift would replace with
 * a handed-in dependency. What is left per file is the seam it reaches or the
 * builtin that holds it, and the routers (the files that mount a Hono app) are
 * counted apart from the middleware, helpers and registries that sit in the same
 * directory, which are not routes.
 *
 * It does not use `adapter-mechanic-check`'s matcher: that one asks whether an
 * adapter reaches a mechanic and answers with an edge ledger, this one asks
 * whether a file could leave Node and answers with a class. Each fails alone.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { isAdapterSource } from './adapter-files.js'
import { MECHANICS_NOT_SCANNED } from './architecture-map.js'
import { type BlockerContext, blockersOf } from './route-closure.js'
import { REPO_ROOT, relativeToRepo, walk } from './scan-roots.js'
import { collectModuleSpecifiers, scanSourceForBoundaryViolations } from './scanner.js'
import { isTestPath } from './source-scan.js'

const ROUTES_DIR = join(REPO_ROOT, 'packages/mcp-server/src/server/routes')

/** A relative import that lands in this root's own mechanics or composition. */
const NODE_BOUND_LOCAL =
  /^\.\.?\/(?:.*\/)?(?:(?:store|daemon|di|export)\/|security\/[a-z0-9-]+-store\.js$|tenant\/data-layout\.js$)/

/**
 * A specifier naming one of this root's own mechanics. `MECHANICS_NOT_SCANNED`
 * are `store/` modules that are not mechanics (an error taxonomy an adapter
 * reads to choose a status code), so the closure enters them and judges what
 * they import instead of calling them Node-bound by directory.
 */
function isMechanicSpecifier(specifier: string): boolean {
  return (
    NODE_BOUND_LOCAL.test(specifier) &&
    !MECHANICS_NOT_SCANNED.some((module) => specifier.endsWith(`store/${module}.js`))
  )
}

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

function classifyAll(dir: string): { portable: string[]; nodeBound: string[] } {
  const portable: string[] = []
  const nodeBound: string[] = []
  for (const file of walk(dir, { include: isAdapterSource })) {
    const name = relative(dir, file).split('\\').join('/')
    const reasons = nodeBoundReasons(file, readFileSync(file, 'utf8'))
    ;(reasons.length === 0 ? portable : nodeBound).push(name)
  }
  return { portable: portable.sort(), nodeBound: nodeBound.sort() }
}

type Role = 'router' | 'middleware' | 'helper' | 'registry'

interface PortableRoute {
  /**
   * `router` mounts a Hono app (`new Hono(`); the rest sit in `routes/` and
   * are not routes. Checked against the source both ways below.
   */
  readonly role: Role
  /**
   * What stops the file leaving Node over its transitive value imports, sorted:
   * `seam <file>` for a cut seam, `<what> in <file>` for a builtin or
   * Node-only package. Empty is a file that could be lifted as it stands.
   */
  readonly blockedBy: readonly string[]
}

const LOG = 'seam log.ts'
const HANDLE = 'seam workspace-handle.ts'
const MCP_SERVER = 'seam mcp/server.ts'
const PROCESS_IN_HELPERS = 'process in app-helpers.ts'
const OS_IN_SHARED = 'node:os in routes/document/_shared.ts'
const CRYPTO_IN_TIMING = 'node:crypto in security/timing-safe.ts'
const BUFFER_IN_TIMING = 'Buffer in security/timing-safe.ts'
const BUFFER_IN_SSE = 'Buffer in sync-streams.ts'

/**
 * The portable files that still sit in `mcp-server`, relative to `routes/`.
 *
 * Guarded from both sides: a portable file missing from here fails as
 * unlisted, and an entry that is no longer portable (gone, lifted into
 * `server-core`, or now importing Node) fails as stale. Each entry also states
 * what holds it, and that statement is checked against the closure, so Node
 * arriving through a helper changes an entry rather than passing. Whether
 * lifting them is the right move is ADR-0052's open decision, and nothing here
 * decides it.
 *
 * Two things the closure found that the direct scan could not say. The
 * routers reach the sync-stream registry (`sync-streams.ts`), which is node-bound
 * only by a `Buffer` global — the base64 helper ADR-0052 names would clear it.
 * And the bearer gate's timing-safe compare is `node:crypto` plus a `Buffer`.
 */
const PORTABLE_ROUTES_IN_MCP_SERVER: Readonly<Record<string, PortableRoute>> = {
  'auth.ts': { role: 'middleware', blockedBy: [BUFFER_IN_TIMING, CRYPTO_IN_TIMING, HANDLE, LOG] },
  'body-limit.ts': { role: 'helper', blockedBy: [] },
  'document-output-path-error.ts': { role: 'helper', blockedBy: [] },
  'read-json-body.ts': { role: 'helper', blockedBy: [] },
  'document/live-doc.ts': { role: 'router', blockedBy: [HANDLE] },
  'document/path-route.ts': { role: 'helper', blockedBy: [HANDLE] },
  'document/restore.ts': { role: 'router', blockedBy: [HANDLE, OS_IN_SHARED] },
  'document/trash.ts': { role: 'router', blockedBy: [HANDLE, LOG] },
  'document/workspaces.ts': { role: 'router', blockedBy: [HANDLE, LOG, OS_IN_SHARED] },
  'mcp.ts': { role: 'router', blockedBy: [LOG, MCP_SERVER, PROCESS_IN_HELPERS] },
  'runtime.ts': { role: 'router', blockedBy: [BUFFER_IN_TIMING, CRYPTO_IN_TIMING] },
  'sync-sse.ts': { role: 'router', blockedBy: [BUFFER_IN_SSE, HANDLE, LOG] },
  'status.ts': { role: 'router', blockedBy: [BUFFER_IN_SSE, HANDLE, LOG] },
  'workspace-people.ts': { role: 'router', blockedBy: [BUFFER_IN_SSE, HANDLE, LOG] },
}

/**
 * The two modules the closure is cut at, relative to `server/`, each with why
 * it is a seam and not a defect of the file that reaches it. Guarded: a seam
 * must be Node-bound ITSELF (cutting a clean module hides nothing but also
 * means nothing) and some ledgered file must reach it.
 */
const CUT_SEAMS: Readonly<Record<string, string>> = {
  'log.ts':
    'the daemon logger writes through pino and Node streams; a lifted route is handed a logger',
  'mcp/server.ts':
    'builds an McpServer over the widget bundle on disk and the package manifest (node:fs, ' +
    'node:module); a lifted `/mcp` route is handed the factory',
  'workspace-handle.ts':
    'resolves an address through the store registry held at module level (a ledgered ' +
    'adapter-mechanic edge); a lifted route is handed the resolved workspace',
}

/**
 * How many entries the ledger may hold, pinned by equality: adding a portable
 * route fails until this is raised on the record, and lifting one fails until
 * it is lowered, so the number keeps saying where the lift stands. The same
 * shape as `ADAPTERS_REACHING_MECHANICS_CEILING`.
 */
const PORTABLE_ROUTES_CEILING = 14

/**
 * What the closure says, pinned by equality for the same reason: a file
 * lifted into `server-core` lowers these, and Node arriving through a helper
 * lowers them too, which is the regression this exists to make loud.
 *
 * - `cleanFiles`: no blocker at all — liftable as they stand.
 * - `liftableFiles`: only the cut seams stand in the way.
 * - `liftableRouters`: the routers among those. This is the number ADR-0052's
 *   decision is about.
 */
const CLOSURE_COUNTS = { cleanFiles: 3, liftableFiles: 6, liftableRouters: 2 } as const

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

const SERVER_REL = 'packages/mcp-server/src/server'

/** Every shipped `.ts` under `mcp-server/src`, repo-relative, for the closure walk. */
function closureContext(): BlockerContext {
  const src = join(REPO_ROOT, 'packages/mcp-server/src')
  const files = new Map<string, string>()
  for (const full of walk(src, {
    include: (path) => path.endsWith('.ts') && !isTestPath(path),
    skip: (_full, name) => name === 'node_modules' || name === 'dist',
  })) {
    files.set(relativeToRepo(full), readFileSync(full, 'utf8'))
  }
  return {
    files,
    root: `${SERVER_REL}/`,
    seams: new Set(Object.keys(CUT_SEAMS).map((seam) => `${SERVER_REL}/${seam}`)),
    isMechanicSpecifier,
    isNodeOnlyPackage,
  }
}

describe('what stops a file leaving Node, over its transitive imports', () => {
  const at = 'srv/routes/a.ts'
  const ctx = (files: Record<string, string>, seams: string[] = []): BlockerContext => ({
    files: new Map(Object.entries(files)),
    root: 'srv/',
    seams: new Set(seams.map((seam) => `srv/${seam}`)),
    isMechanicSpecifier,
    isNodeOnlyPackage,
  })

  it('finds a Node builtin that arrives through a helper the route imports', () => {
    // The shape that stayed green when `node:fs` was planted in validators.ts.
    expect(
      blockersOf(
        at,
        ctx({
          [at]: "import { v } from '../validators.js'\nexport const r = v\n",
          'srv/validators.ts': "import 'node:fs'\nexport const v = 1\n",
        }),
      ),
    ).toEqual(['node:fs in validators.ts'])
  })

  it('follows the closure down more than one hop, and through a re-export', () => {
    expect(
      blockersOf(
        at,
        ctx({
          [at]: "export * from '../h1.js'\n",
          'srv/h1.ts': "import { h } from './h2.js'\nexport const x = h\n",
          'srv/h2.ts': 'export const h = process.env.HOME\n',
        }),
      ),
    ).toEqual(['process in h2.ts'])
  })

  it('names a cut seam and does not enter it', () => {
    expect(
      blockersOf(
        at,
        ctx(
          {
            [at]: "import { log } from '../log.js'\nexport const r = log\n",
            'srv/log.ts':
              "import pino from 'pino'\nimport 'node:stream'\nexport const log = pino\n",
          },
          ['log.ts'],
        ),
      ),
    ).toEqual(['seam log.ts'])
  })

  it("names a Node-only package and one of this root's mechanics", () => {
    expect(
      blockersOf(
        at,
        ctx({
          [at]: "import '../h.js'\nimport { s } from '../store/doc.js'\nexport const r = s\n",
          'srv/h.ts': "import pino from 'pino'\nexport const p = pino\n",
          'srv/store/doc.ts': "import 'node:fs'\nexport const s = 1\n",
        }),
      ),
    ).toEqual(['mechanic store/doc.ts', 'pino in h.ts'])
  })

  it('ignores a type-only import of something Node-bound, which emit erases', () => {
    expect(
      blockersOf(
        at,
        ctx({
          [at]: "import type { S } from '../store/doc.js'\nimport type { P } from '../h.js'\nexport type R = S | P\n",
          'srv/h.ts': "import 'node:fs'\nexport type P = 1\n",
          'srv/store/doc.ts': 'export type S = 1\n',
        }),
      ),
    ).toEqual([])
  })

  it('answers nothing for a closure that is clean', () => {
    expect(
      blockersOf(
        at,
        ctx({
          [at]: "import { z } from 'zod'\nimport { h } from '../h.js'\nexport const r = [z, h]\n",
          'srv/h.ts': 'export const h = 1\n',
        }),
      ),
    ).toEqual([])
  })
})

describe('mcp-server routes that could run somewhere other than Node', () => {
  const { portable, nodeBound } = classifyAll(ROUTES_DIR)
  const ledgered = Object.keys(PORTABLE_ROUTES_IN_MCP_SERVER)

  // A walk that found nothing, or a classifier that put everything in one
  // class, would pass every assertion below while checking nothing.
  it('classifies the real route tree into both classes', () => {
    expect(portable.length + nodeBound.length).toBeGreaterThan(25)
    expect(portable.length).toBeGreaterThan(5)
    expect(nodeBound.length).toBeGreaterThan(5)
  })

  it('lists every portable route that sits in mcp-server', () => {
    expect(
      ledgerDrift(portable, ledgered).unlisted,
      'a route under mcp-server/src/server/routes imports nothing Node-bound, so a ' +
        'keeper that is not this daemon would write it again. Put it in server-core ' +
        'behind a seam, or list it in PORTABLE_ROUTES_IN_MCP_SERVER and raise the ceiling.',
    ).toEqual([])
  })

  it('lists no route that has stopped being a portable one', () => {
    expect(
      ledgerDrift(portable, ledgered).stale,
      'these entries are gone, lifted into server-core, or now import something ' +
        'Node-bound — delete them and lower PORTABLE_ROUTES_CEILING.',
    ).toEqual([])
  })

  it('holds the ledger at its declared ceiling', () => {
    expect(
      ledgered.length,
      ledgered.length > PORTABLE_ROUTES_CEILING
        ? 'a portable route was added to mcp-server. Lift it, or raise the ceiling in the same diff and say why.'
        : 'a route was lifted or went node-bound — lower PORTABLE_ROUTES_CEILING to match.',
    ).toBe(PORTABLE_ROUTES_CEILING)
  })

  it('says, per file, which routers mount an app and which files are not routes', () => {
    const actual = ledgered.map((name) => ({
      name,
      mountsApp: /new Hono\(/.test(readFileSync(join(ROUTES_DIR, name), 'utf8')),
    }))
    const wrong = actual
      .filter(
        ({ name, mountsApp }) =>
          mountsApp !== ((PORTABLE_ROUTES_IN_MCP_SERVER[name] as PortableRoute).role === 'router'),
      )
      .map(({ name }) => name)
    expect(
      wrong,
      'a ledgered file is labelled a router and mounts no Hono app, or the other way round',
    ).toEqual([])
  })
})

describe('the transitive closure of the portable files', () => {
  const ctx = closureContext()
  const blockers = (name: string): string[] => blockersOf(`${SERVER_REL}/routes/${name}`, ctx)
  const ledgered = Object.entries(PORTABLE_ROUTES_IN_MCP_SERVER)

  it('reads the tree it walks', () => {
    expect(ctx.files.size, 'the closure walk found almost nothing').toBeGreaterThan(250)
    for (const [name] of ledgered) {
      expect(ctx.files.has(`${SERVER_REL}/routes/${name}`), `${name} is not in the walk`).toBe(true)
    }
  })

  it('states for every ledgered file exactly what holds it', () => {
    const drift = ledgered
      .map(([name, entry]) => ({
        name,
        ledger: [...entry.blockedBy].sort(),
        actual: blockers(name),
      }))
      .filter(({ ledger, actual }) => JSON.stringify(ledger) !== JSON.stringify(actual))
    expect(
      drift,
      'a ledgered file reaches a different set of Node-bound things than its entry says. A new ' +
        'builtin means Node arrived through a helper; a vanished one means a lift got closer — ' +
        'update blockedBy, and the CLOSURE_COUNTS if the totals moved.',
    ).toEqual([])
  })

  it('keeps every cut seam Node-bound itself, and reached by a ledgered file', () => {
    const uncut = { ...ctx, seams: new Set<string>() }
    for (const seam of Object.keys(CUT_SEAMS)) {
      const own = blockersOf(`${SERVER_REL}/${seam}`, uncut)
      expect(own, `${seam} is clean, so cutting it hides nothing and it is not a seam`).not.toEqual(
        [],
      )
      expect(
        ledgered.some(([, entry]) => entry.blockedBy.includes(`seam ${seam}`)),
        `${seam} is reached by no ledgered file — drop it from CUT_SEAMS`,
      ).toBe(true)
      expect(CUT_SEAMS[seam]?.trim().length ?? 0, `${seam} has no reason`).toBeGreaterThan(20)
    }
  })

  it('pins how many files and routers could be lifted, by equality', () => {
    const only = (entry: PortableRoute): boolean =>
      entry.blockedBy.every((blocker) => blocker.startsWith('seam '))
    const counts = {
      cleanFiles: ledgered.filter(([, entry]) => entry.blockedBy.length === 0).length,
      liftableFiles: ledgered.filter(([, entry]) => only(entry)).length,
      liftableRouters: ledgered.filter(([, entry]) => entry.role === 'router' && only(entry))
        .length,
    }
    expect(
      counts,
      'the lift moved: a file was lifted or gained a Node blocker. Lower (or, on the record, raise) CLOSURE_COUNTS.',
    ).toEqual(CLOSURE_COUNTS)
  })
})

/** Spelled the way the ADR's prose spells a count; past twenty a figure is clearer. */
function spell(n: number): string {
  const words = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
  ]
  return words[n] ?? String(n)
}

/** ADR-0052's correction note, from its heading to the end of the file. */
function adrCorrectionNote(): string {
  const adr = readFileSync(join(REPO_ROOT, 'docs/contributing/adr/0052-edge-keeper.md'), 'utf8')
  const start = adr.indexOf('## Correction note')
  // Prose wraps; a sentence is compared as one line.
  return start === -1 ? '' : adr.slice(start).replace(/\s+/g, ' ')
}

describe("ADR-0052's correction note states what the ledger holds", () => {
  const note = adrCorrectionNote()
  const ledgered = Object.entries(PORTABLE_ROUTES_IN_MCP_SERVER)
  const only = (entry: PortableRoute): boolean =>
    entry.blockedBy.every((blocker) => blocker.startsWith('seam '))
  const routers = ledgered.filter(([, entry]) => entry.role === 'router')

  it('reads a note at all', () => {
    expect(note.length, 'the correction note is missing or its heading moved').toBeGreaterThan(2000)
  })

  it('names every ledgered file', () => {
    expect(
      ledgered.map(([name]) => name).filter((name) => !note.includes(`\`${name}\``)),
      "a file in PORTABLE_ROUTES_IN_MCP_SERVER is absent from the note's table",
    ).toEqual([])
  })

  it('names every cut seam, and how many there are', () => {
    expect(
      Object.keys(CUT_SEAMS).filter((seam) => !note.includes(`\`${seam}\``)),
      'a cut seam is absent from the note',
    ).toEqual([])
    expect(note).toContain(`${spell(Object.keys(CUT_SEAMS).length)} named cut seams`)
  })

  it('states the ledger length, the router count and the three closure counts', () => {
    const { cleanFiles, liftableFiles, liftableRouters } = CLOSURE_COUNTS
    const total = spell(ledgered.length)
    expect(note).toContain(`Of the ${total} files, ${spell(routers.length)} are routers`)
    expect(note).toContain(`**${spell(cleanFiles)}** of the ${total} are clean`)
    expect(note).toContain(`**${spell(liftableFiles)}** are held only by the cut seams`)
    expect(note).toContain(`**${spell(liftableRouters)}** of the ${spell(routers.length)} routers`)
    expect(ledgered.filter(([, entry]) => only(entry)).length).toBe(liftableFiles)
  })
})
