/**
 * `packages/mcp-server/src` has layers, and until this test the only thing that
 * held them was ADR-0018's one-way scan (an adapter may not reach a mechanic).
 * Everything else was convention: a store importing a route, or `shared/`
 * importing the server's logger, passed every test and every guard — both were
 * planted, in `store/names-store.ts` and `shared/sha256.ts`, and the whole
 * project stayed green. `web-layer-order.test.ts` is the same guard
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
import {
  ADAPTER_ENTITLED_MECHANICS,
  isAdapterEntitled,
  isAdapterForbiddenMechanic,
  isMechanicsLayerModule,
  MECHANIC_DIRS,
  serverModulePath,
  TOP_LEVEL_MECHANICS,
} from './adapter-reach.js'
import { ADAPTER_HELPER_FILES } from './architecture-map.js'
import { collectRelativeImportEdges } from './cycle-check.js'
import { REPO_ROOT, walk } from './scan-roots.js'
import { isTestPath } from './source-scan.js'
import { resolveRelativeSource } from './value-import-closure.js'

const SRC = join(REPO_ROOT, 'packages/mcp-server/src')

/** Bottom to top. */
const LAYERS = ['shared', 'daemon', 'mechanics', 'adapters', 'composition', 'entry'] as const
type Layer = (typeof LAYERS)[number]

const rank = (layer: Layer): number => LAYERS.indexOf(layer)

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
  // The mechanisms are `adapter-reach.ts`'s `TOP_LEVEL_MECHANICS`, the one
  // definition the adapter-mechanic finder also derives from.
  ...Object.fromEntries(TOP_LEVEL_MECHANICS.map((path) => [path, 'mechanics' as const])),
  // Translation shared between routes: exactly `ADAPTER_HELPER_FILES`, which the
  // adapter scans read, and the last test below holds the two lists to it.
  'server/workspace-handle.ts': 'adapters',
  'server/app-helpers.ts': 'adapters',
  // The roots that wire a running server, and the type of what `createApp` is
  // handed — read by `app.ts` alone.
  'server/app-types.ts': 'composition',
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
  'server/security/membership-gate.ts -> server/workspace-handle.ts':
    'the gate resolves an address through the adapter helper `workspace-handle.ts`; handing it the ' +
    'resolved workspace, as `createApp` hands routes everything else, retires it',
}

/** How many entries {@link UPWARD_EDGES} may hold — pinned by equality, a ratchet and not a budget. */
const UPWARD_EDGES_CEILING = 1

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

// The adapter-mechanic finder and this guard's `mechanics` layer used to be two
// definitions that disagreed: the finder knew five directories, the layer knew
// the top-level `atomic-write`, `output-path` and `config` too, and an adapter
// importing one was in neither ledger. `adapter-reach.ts` is now the one list;
// this holds that the finder's verdict is total over it.
describe('the mechanics layer and the adapter-mechanic finder share one definition', () => {
  const serverFiles = FILES.filter(({ path }) => path.startsWith('server/'))
  const modulePathOf = (path: string): string => serverModulePath(path)
  const inLayer = serverFiles.filter(({ path }) => layerOf(path) === 'mechanics')

  it('reaches the mechanics layer', () => {
    expect(
      inLayer.length,
      'the layer is empty, so every assertion below is vacuous',
    ).toBeGreaterThan(60)
  })

  it('files exactly the modules the shared definition calls mechanics', () => {
    const disagree = serverFiles
      .filter(
        ({ path }) =>
          (layerOf(path) === 'mechanics') !== isMechanicsLayerModule(modulePathOf(path)),
      )
      .map(({ path }) => path)
    expect(disagree).toEqual([])
  })

  it('gives every mechanics-layer module exactly one verdict: a mechanic to ledger, or one an adapter may import', () => {
    const neither = inLayer
      .map(({ path }) => modulePathOf(path))
      .filter((module) => isAdapterForbiddenMechanic(module) === isAdapterEntitled(module))
    expect(neither).toEqual([])
  })

  it('names every entitlement as a module that exists in the mechanics layer, with a reason of substance', () => {
    const modules = new Set(inLayer.map(({ path }) => modulePathOf(path)))
    const idle = ADAPTER_ENTITLED_MECHANICS.flatMap(({ modules: named, reason }) => [
      ...(reason.trim().length <= 20 ? [`reason: ${reason}`] : []),
      ...named.filter((module) => !modules.has(module)),
    ])
    expect(idle, 'an entitlement naming no module is a permission nobody uses').toEqual([])
  })

  it('names no module twice', () => {
    const named = ADAPTER_ENTITLED_MECHANICS.flatMap(({ modules }) => modules)
    expect(named.filter((module, i) => named.indexOf(module) !== i)).toEqual([])
  })

  // Entitlement is by name, so a module sitting in an entitled directory is a
  // mechanic until someone decides otherwise. These keep, rows or files and are
  // in `security/` and `tenant/` without being called `*-store`.
  it('still calls a mechanic every module that keeps rows or files, wherever it is filed', () => {
    const modules = inLayer.map(({ path }) => modulePathOf(path))
    const keepers = [
      'security/user-deletion',
      'security/user-deactivation',
      'security/secret-file-mode',
      'security/server-mode-record',
      'security/sign-in-config-file',
      'security/member-profile-store',
      'tenant/data-layout',
      'tenant/storage-report',
      'server/atomic-write',
    ].map((module) => module.replace(/^server\//, ''))
    expect(keepers.filter((module) => !modules.includes(module))).toEqual([])
    expect(keepers.filter((module) => !isAdapterForbiddenMechanic(module))).toEqual([])
  })

  it('still calls every module the finder always matched a mechanic', () => {
    const modules = inLayer.map(({ path }) => modulePathOf(path))
    const stillMechanic = (module: string): boolean =>
      module.startsWith('store/') ||
      module.startsWith('export/') ||
      /^security\/[a-z0-9-]+-store$/.test(module) ||
      module === 'tenant/data-layout'
    const expected = modules.filter(stillMechanic)
    expect(expected.length).toBeGreaterThan(25)
    expect(expected.filter((module) => !isAdapterForbiddenMechanic(module))).toEqual([])
  })

  it('scans as adapters exactly the top-level files it files in the adapters layer', () => {
    const filed = Object.entries(TOP_LEVEL)
      .filter(([, layer]) => layer === 'adapters')
      .map(([path]) => path.replace(/^server\//, ''))
      .sort()
    expect(filed).toEqual([...ADAPTER_HELPER_FILES].sort())
  })
})
