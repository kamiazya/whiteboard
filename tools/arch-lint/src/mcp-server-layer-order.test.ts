/**
 * `packages/mcp-server/src` has layers, and until this test the only thing that
 * held them was ADR-0018's one-way scan (an adapter may not reach a mechanic).
 * Everything else was convention: a store importing a route, or `shared/`
 * importing the server's logger, passed every test and every guard — both were
 * planted, in `store/names-store.ts` and `shared/sha256.ts`, and the whole
 * project stayed green. `apps/web/src/layer-order.test.ts` is the same guard
 * for the other root; this is its counterpart.
 *
 * The order, bottom to top. A module may import its own layer or any layer
 * before it, and the layers are derived from how the code is USED, not from the
 * directory names alone:
 *
 *   shared       `shared/**` — contracts and utilities nothing is above.
 *   daemon       `daemon/**` — the process-level housekeeping of one daemon:
 *                pid, lock, socket, registry, the native host.
 *   mechanics    how this keeper stores, caches, schedules and secures:
 *                `server/{store,security,tenant,export,search,observability,
 *                release}/**` plus the top-level `server/*.ts` that are
 *                mechanisms (the logger, config, atomic write, the background
 *                work declarations, the notifier).
 *   adapters     ADR-0018's translation: `server/routes/**`, `server/mcp/**`
 *                and the helpers routes share (`workspace-handle.ts`).
 *   composition  what wires the layers below into a running server: `app.ts`,
 *                the HTTP roots, and `di/**`.
 *   entry        what a process starts from: `cli/**`, `server/index.ts`,
 *                `daemon-entry.ts` and the MCP stdio root.
 *
 * Measured before writing this: eight upward edges (see `UPWARD_EDGES`), none
 * of them a surprise once the layers were named — each is a module filed in the
 * wrong directory (a scheduler under `routes/`) rather than a design that wants the edge. They
 * are ledgered rather than moved here because each is a relocation with its own
 * importers, and the count may only fall.
 *
 * Type-only edges COUNT, as in the web guard: erased at emit, but layering is
 * about what a module has to know, and a store that names a route's type is a
 * store whose contract is defined above it.
 *
 * Test support is out: `*.test.ts`, `_test-*` and `test-utils/` build an app
 * the way a root does and import freely.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectRelativeImportEdges } from './cycle-check.js'
import { REPO_ROOT, walk } from './scan-roots.js'
import { isTestPath } from './source-scan.js'
import { resolveRelativeSource } from './value-import-closure.js'

const SRC = join(REPO_ROOT, 'packages/mcp-server/src')

/** Bottom to top. */
const LAYERS = ['shared', 'daemon', 'mechanics', 'adapters', 'composition', 'entry'] as const
type Layer = (typeof LAYERS)[number]

const rank = (layer: Layer): number => LAYERS.indexOf(layer)

/** `server/<dir>/**` that hold mechanics. */
const MECHANIC_DIRS: ReadonlySet<string> = new Set([
  'store',
  'security',
  'tenant',
  'export',
  'search',
  'observability',
  'release',
])

/**
 * The one file under `server/mcp/` that is a process entry rather than a tool
 * registration: it starts the stdio root (`server/stdio-root.ts`), so it sits
 * above it.
 */
const MCP_PROCESS_ENTRY = 'server/mcp/stdio.ts'

/**
 * Top-level `server/*.ts`, each named. Named rather than guessed so a new one
 * has to be placed: a file in none of these fails `belongs to no layer`.
 */
const TOP_LEVEL: Readonly<Record<string, Layer>> = {
  // Mechanisms: the logger, configuration and environment, atomic writes, the
  // declared background work and what it runs, the live-audience notifier, the
  // backup mechanics, and the identity/workspace resolution the stores and
  // `di/` build on.
  'server/log.ts': 'mechanics',
  'server/server-core-logs.ts': 'mechanics',
  'server/config.ts': 'mechanics',
  'server/config-file.ts': 'mechanics',
  'server/startup-env.ts': 'mechanics',
  'server/replica-env.ts': 'mechanics',
  'server/data-dir-writable.ts': 'mechanics',
  'server/atomic-write.ts': 'mechanics',
  'server/validators.ts': 'mechanics',
  'server/output-path.ts': 'mechanics',
  'server/backup-restore.ts': 'mechanics',
  'server/server-mode-backup-restore.ts': 'mechanics',
  'server/background-work.ts': 'mechanics',
  'server/background-work-costs.ts': 'mechanics',
  'server/shared-background-work.ts': 'mechanics',
  'server/canvas-client-notifier.ts': 'mechanics',
  // What is open and listening: the registry of sync streams, the audience
  // vocabulary the daemon speaks over it, and the viewport-request cache the
  // two share. The route that opens a stream (`routes/sync-sse.ts`) sits above.
  'server/sync-streams.ts': 'mechanics',
  'server/sync-audience.ts': 'mechanics',
  'server/viewport-requests.ts': 'mechanics',
  'server/daemon-actor.ts': 'mechanics',
  'server/daemon-auth-binding.ts': 'mechanics',
  'server/current-workspace.ts': 'mechanics',
  // Startup clean-up of data-dir artifacts a retired feature left behind.
  'server/purge-legacy-trust-file.ts': 'mechanics',
  // Translation shared between routes (`ADAPTER_HELPER_FILES` names the first).
  'server/workspace-handle.ts': 'adapters',
  'server/app-helpers.ts': 'adapters',
  'server/app-types.ts': 'adapters',
  // The roots that wire a running server.
  'server/app.ts': 'composition',
  'server/http-server.ts': 'composition',
  'server/server-mode-http.ts': 'composition',
  'server/server-mode-web-app.ts': 'composition',
  // Process entries.
  'server/index.ts': 'entry',
  'server/daemon-entry.ts': 'entry',
  'server/stdio-root.ts': 'entry',
}

/** The layer of a path relative to `src/`, or `undefined` when it belongs to none. */
function layerOf(path: string): Layer | undefined {
  const [top, second] = path.split('/')
  if (top === 'shared') return 'shared'
  if (top === 'daemon') return 'daemon'
  if (top === 'di') return 'composition'
  if (top === 'cli') return 'entry'
  if (top !== 'server') return undefined
  if (path.split('/').length === 2) return TOP_LEVEL[path]
  if (second === 'routes') return 'adapters'
  if (second === 'mcp') return path === MCP_PROCESS_ENTRY ? 'entry' : 'adapters'
  return MECHANIC_DIRS.has(second as string) ? 'mechanics' : undefined
}

interface SourceFile {
  /** Relative to `src/`, `/`-separated. */
  readonly path: string
  readonly text: string
}

/** One edge as the ledger spells it (a store file reaching a route), `(type)` when erased at emit. */
function upwardEdges(files: readonly SourceFile[]): string[] {
  const known = new Set(files.map(({ path }) => path))
  const edges: string[] = []
  for (const { path, text } of files) {
    const from = layerOf(path)
    if (from === undefined) continue
    for (const { specifier, typeOnly } of collectRelativeImportEdges(path, text)) {
      const target = resolveRelativeSource(path, specifier, (candidate) => known.has(candidate))
      const to = target === null ? undefined : layerOf(target)
      if (target === null || to === undefined || rank(to) <= rank(from)) continue
      edges.push(`${path} -> ${target}${typeOnly ? ' (type)' : ''}`)
    }
  }
  return [...new Set(edges)].sort()
}

const isShipped = (path: string): boolean => !isTestPath(path) && !/(^|\/)_test-/.test(path)

const FILES: readonly SourceFile[] = walk(SRC, {
  include: (full) => /\.tsx?$/.test(full),
  skip: (_full, name) => name === 'node_modules' || name === 'dist',
})
  .map((full) => full.slice(SRC.length + 1).replaceAll('\\', '/'))
  .filter(isShipped)
  .map((path) => ({ path, text: readFileSync(join(SRC, path), 'utf8') }))

/**
 * Every upward edge that exists today, each a relocation still to do — with
 * the move that retires it. Never add to this for new code: file the module
 * where its importers can reach it.
 */
const UPWARD_EDGES: Readonly<Record<string, string>> = {
  'server/mcp/tarball.distribution-impl.ts -> cli/operator-json.ts':
    'distribution-smoke support filed under the adapter tree reaches the CLI JSON sink; moving ' +
    'the smoke impls beside the smokes retires it',
  'server/security/membership-gate.ts -> server/workspace-handle.ts':
    'the gate resolves an address through the adapter helper `workspace-handle.ts`; handing it the ' +
    'resolved workspace, as `createApp` hands routes everything else, retires it',
}

/** How many entries {@link UPWARD_EDGES} may hold — pinned by equality, a ratchet and not a budget. */
const UPWARD_EDGES_CEILING = 2

describe('what counts as an upward edge', () => {
  const edgesOf = (files: Record<string, string>): string[] =>
    upwardEdges(Object.entries(files).map(([path, text]) => ({ path, text })))

  it('refuses a store that imports a route', () => {
    expect(
      edgesOf({
        'server/store/names-store.ts': "import '../routes/status.js'\n",
        'server/routes/status.ts': 'export const s = 1\n',
      }),
    ).toEqual(['server/store/names-store.ts -> server/routes/status.ts'])
  })

  it('refuses shared importing the server logger', () => {
    expect(
      edgesOf({
        'shared/sha256.ts': "import '../server/log.js'\n",
        'server/log.ts': 'export const l = 1\n',
      }),
    ).toEqual(['shared/sha256.ts -> server/log.ts'])
  })

  it('tags a type-only edge and still counts it', () => {
    expect(
      edgesOf({
        'server/store/x.ts': "import type { R } from '../routes/y.js'\n",
        'server/routes/y.ts': 'export type R = 1\n',
      }),
    ).toEqual(['server/store/x.ts -> server/routes/y.ts (type)'])
  })

  it('reads a dynamic and a re-export edge too', () => {
    expect(
      edgesOf({
        'server/store/a.ts': "export const f = () => import('../routes/y.js')\n",
        'server/store/b.ts': "export * from '../routes/y.js'\n",
        'server/routes/y.ts': 'export const y = 1\n',
      }),
    ).toEqual([
      'server/store/a.ts -> server/routes/y.ts',
      'server/store/b.ts -> server/routes/y.ts',
    ])
  })

  it('allows the same layer and every downward edge', () => {
    expect(
      edgesOf({
        'server/routes/a.ts':
          "import './b.js'\nimport '../store/s.js'\nimport '../../shared/u.js'\n",
        'server/routes/b.ts': 'export const b = 1\n',
        'server/store/s.ts': "import '../log.js'\n",
        'server/log.ts': 'export const l = 1\n',
        'shared/u.ts': 'export const u = 1\n',
      }),
    ).toEqual([])
  })

  it('treats the stdio root and its process entry as entries, above the library the app composes', () => {
    expect(layerOf('server/stdio-root.ts')).toBe('entry')
    expect(layerOf('server/mcp/stdio.ts')).toBe('entry')
    expect(layerOf('server/mcp/server.ts')).toBe('adapters')
    expect(layerOf('server/mcp/document-tools.ts')).toBe('adapters')
  })
})

describe('mcp-server layer order', () => {
  const actual = upwardEdges(FILES)

  it('scans every layer', () => {
    // A walk that matched nothing, or a classifier that put everything in one
    // layer, passes every assertion below for the wrong reason.
    expect(FILES.length, 'the source walk found almost nothing').toBeGreaterThan(250)
    for (const layer of LAYERS) {
      expect(
        FILES.filter(({ path }) => layerOf(path) === layer).length,
        `no production module is filed under ${layer}`,
      ).toBeGreaterThan(0)
    }
  })

  it('files every production module in a layer', () => {
    const unfiled = FILES.filter(({ path }) => layerOf(path) === undefined).map(({ path }) => path)
    expect(
      unfiled,
      'a module belongs to no layer — a new top-level `server/*.ts` is named in TOP_LEVEL, and a ' +
        'new directory under `server/` in MECHANIC_DIRS (or it is an adapter)',
    ).toEqual([])
  })

  it('names only top-level files that still exist', () => {
    const paths = new Set(FILES.map(({ path }) => path))
    expect(Object.keys(TOP_LEVEL).filter((path) => !paths.has(path))).toEqual([])
  })

  it('has no upward edge outside the ledger', () => {
    expect(
      actual.filter((edge) => UPWARD_EDGES[edge] === undefined),
      'a module imports from a layer above it — move what it needs down rather than adding to the ledger',
    ).toEqual([])
  })

  it('keeps every ledger entry a real edge with a reason of substance', () => {
    const stale = Object.entries(UPWARD_EDGES)
      .filter(([edge, reason]) => !actual.includes(edge) || reason.trim().length <= 20)
      .map(([edge]) => edge)
    expect(stale, 'an entry that outlives its edge is how a ledger stops being read').toEqual([])
  })

  it('holds the ledger at its declared ceiling', () => {
    expect(Object.keys(UPWARD_EDGES).length).toBe(UPWARD_EDGES_CEILING)
  })
})
