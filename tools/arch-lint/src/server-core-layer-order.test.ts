/**
 * `packages/server-core/src` has layers, and nothing else holds them:
 * `cycle-check` is file-level and the package-direction checks read manifests,
 * so a file under `search/` importing `tools/errors.ts` passes every other guard
 * in this project. A loop among `tools/`, `search/` and `references/` is what
 * stops them being lifted or ported one at a time, and it closes through a
 * single file. `mcp-server-layer-order.test.ts` is this guard's counterpart for
 * the other package.
 *
 * The order, bottom to top. A module may import its own layer or any layer
 * before it:
 *
 *   shared       the root files every directory reads and that read no
 *                directory: server deps, the logger, document IO and the small
 *                request/error vocabularies.
 *   base         `versions/`, `references/` and `render/` — what a document
 *                has been, points at, and looks like.
 *   services     `operations/` (writes, over `versions/`) and `search/` (over
 *                `references/`).
 *   tools        `tools/` — the MCP tool and route definitions that call all of
 *                the above.
 *   composition  the root files that wire tools into `createServer` and the
 *                package's public surface.
 *
 * A layer being shared does not let its directories see each other: the
 * directory graph must also be acyclic, which the same-layer allowance alone
 * would not say.
 *
 * Type-only edges COUNT: erased at emit, but a layer's contract defined above
 * it is the same dependency to anyone lifting the layer.
 *
 * Test support is out: `*.test.ts` and `test-utils/` build a server the way a
 * root does and import freely.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectRelativeImportEdges } from './cycle-check.js'
import { REPO_ROOT, walk } from './scan-roots.js'
import { isShippedPath } from './source-scan.js'
import { resolveRelativeSource } from './value-import-closure.js'

const SRC = join(REPO_ROOT, 'packages/server-core/src')

/** Bottom to top. */
const LAYERS = ['shared', 'base', 'services', 'tools', 'composition'] as const
type Layer = (typeof LAYERS)[number]

const rank = (layer: Layer): number => LAYERS.indexOf(layer)

const DIRECTORY_LAYERS: Readonly<Record<string, Layer>> = {
  versions: 'base',
  references: 'base',
  render: 'base',
  operations: 'services',
  search: 'services',
  tools: 'tools',
}

/**
 * Root `*.ts`, each named by ROLE. Named rather than guessed so a new one has to
 * be placed: a file in none of these fails `belongs to no layer`.
 */
const ROOT_FILES: Readonly<Record<string, Layer>> = {
  'server-deps.ts': 'shared',
  'log.ts': 'shared',
  'log-levels.ts': 'shared',
  'document-io.ts': 'shared',
  'api-errors.ts': 'shared',
  'theme-font.ts': 'shared',
  'viewport-request.ts': 'shared',
  // Read by `createServer` alone, and each reaches into `tools/` for what it
  // translates.
  'workspace-handle.ts': 'composition',
  'search-query.ts': 'composition',
  // The package's public surface and its wiring.
  'create-server.ts': 'composition',
  'index.ts': 'composition',
  'contracts.ts': 'composition',
}

/** The layer of a path relative to `src/`, or `undefined` when it belongs to none. */
function layerOf(path: string): Layer | undefined {
  const parts = path.split('/')
  if (parts.length === 1) return ROOT_FILES[path]
  return DIRECTORY_LAYERS[parts[0] as string]
}

/** The directory name for a file under one, the file name for a root file. */
const unitOf = (path: string): string => (path.includes('/') ? path.split('/')[0] : path) as string

interface SourceFile {
  /** Relative to `src/`, `/`-separated. */
  readonly path: string
  readonly text: string
}

interface Edge {
  readonly from: string
  readonly to: string
  readonly typeOnly: boolean
}

function edgesOf(files: readonly SourceFile[]): readonly Edge[] {
  const known = new Set(files.map(({ path }) => path))
  return files.flatMap(({ path, text }) =>
    collectRelativeImportEdges(path, text).flatMap(({ specifier, typeOnly }) => {
      const target = resolveRelativeSource(path, specifier, (candidate) => known.has(candidate))
      return target === null ? [] : [{ from: path, to: target, typeOnly }]
    }),
  )
}

const spell = ({ from, to, typeOnly }: Edge): string =>
  `${from} -> ${to}${typeOnly ? ' (type)' : ''}`

/** Every import that reaches a layer above the importer's own. */
function upwardEdges(files: readonly SourceFile[]): string[] {
  const upward = edgesOf(files).filter((edge) => {
    const from = layerOf(edge.from)
    const to = layerOf(edge.to)
    return from !== undefined && to !== undefined && rank(to) > rank(from)
  })
  return [...new Set(upward.map(spell))].sort()
}

/** Directory loops, each as the sorted names that form it. Root files are not directories. */
function directoryCycles(files: readonly SourceFile[]): string[][] {
  const graph = new Map<string, Set<string>>()
  for (const { from, to } of edgesOf(files)) {
    if (!from.includes('/') || !to.includes('/')) continue
    const [a, b] = [unitOf(from), unitOf(to)]
    if (!graph.has(a)) graph.set(a, new Set())
    if (!graph.has(b)) graph.set(b, new Set())
    if (a !== b) graph.get(a)?.add(b)
  }
  const reaches = (start: string, goal: string, seen = new Set<string>()): boolean =>
    [...(graph.get(start) ?? [])].some((next) => {
      if (next === goal) return true
      if (seen.has(next)) return false
      seen.add(next)
      return reaches(next, goal, seen)
    })
  const looping = [...graph.keys()].filter((unit) => reaches(unit, unit))
  const components = new Map<string, string[]>()
  for (const unit of looping) {
    const members = looping.filter((other) => reaches(unit, other) && reaches(other, unit)).sort()
    components.set(members.join(','), members)
  }
  return [...components.values()]
}

const FILES: readonly SourceFile[] = walk(SRC, {
  include: (full) => /\.tsx?$/.test(full),
  skip: (_full, name) => name === 'node_modules' || name === 'dist',
})
  .map((full) => full.slice(SRC.length + 1).replaceAll('\\', '/'))
  .filter(isShippedPath)
  .map((path) => ({ path, text: readFileSync(join(SRC, path), 'utf8') }))

/**
 * Every upward edge that exists today, with what retires it. Never add to this
 * for new code: file the module where its importers can reach it.
 */
const UPWARD_EDGES: Readonly<Record<string, string>> = {
  'server-deps.ts -> search/embedder.ts (type)':
    'ServerDeps names the Embedder its port returns, and the type is defined by the directory that ' +
    'owns the implementation; lifting the interface to a root file retires it',
  'server-deps.ts -> versions/version-entry.ts (type)':
    'ServerDeps names the version row and attestation types its store returns, defined where the ' +
    'rows are built; lifting them to a root file retires it',
}

/** How many entries {@link UPWARD_EDGES} may hold — pinned by equality, a ratchet and not a budget. */
const UPWARD_EDGES_CEILING = 2

describe('what counts as an upward edge', () => {
  const upwardOf = (files: Record<string, string>): string[] =>
    upwardEdges(Object.entries(files).map(([path, text]) => ({ path, text })))

  it('refuses a search module that imports a tool', () => {
    expect(
      upwardOf({
        'search/zz-plant.ts': "import '../tools/errors.js'\n",
        'tools/errors.ts': 'export const e = 1\n',
      }),
    ).toEqual(['search/zz-plant.ts -> tools/errors.ts'])
  })

  it('refuses a references module reaching a tool, the loop this guard exists for', () => {
    expect(
      upwardOf({
        'references/content-source.ts': "import { x } from '../tools/loader.js'\n",
        'tools/loader.ts': 'export const x = 1\n',
      }),
    ).toEqual(['references/content-source.ts -> tools/loader.ts'])
  })

  it('refuses a shared root file importing a directory, and tags a type-only edge', () => {
    expect(
      upwardOf({
        'log.ts': "import type { T } from './search/embedder.js'\n",
        'search/embedder.ts': 'export type T = 1\n',
      }),
    ).toEqual(['log.ts -> search/embedder.ts (type)'])
  })

  it('reads a dynamic and a re-export edge too', () => {
    expect(
      upwardOf({
        'references/a.ts': "export const f = () => import('../tools/y.js')\n",
        'references/b.ts': "export * from '../tools/y.js'\n",
        'tools/y.ts': 'export const y = 1\n',
      }),
    ).toEqual(['references/a.ts -> tools/y.ts', 'references/b.ts -> tools/y.ts'])
  })

  it('allows the same layer and every downward edge', () => {
    expect(
      upwardOf({
        'tools/a.ts': "import '../search/s.js'\nimport '../server-deps.js'\nimport './b.js'\n",
        'tools/b.ts': 'export const b = 1\n',
        'search/s.ts': "import '../references/r.js'\nimport '../server-deps.js'\n",
        'references/r.ts': "import '../document-io.js'\n",
        'document-io.ts': 'export const d = 1\n',
        'server-deps.ts': 'export const s = 1\n',
        'create-server.ts': "import './tools/a.js'\n",
      }),
    ).toEqual([])
  })

  it('finds a loop between two directories of one layer, which the layer order allows', () => {
    expect(
      directoryCycles([
        { path: 'references/a.ts', text: "import '../render/b.js'\n" },
        { path: 'render/b.ts', text: "import '../references/a.js'\n" },
      ]),
    ).toEqual([['references', 'render']])
  })

  it('does not call a root file a directory loop', () => {
    expect(
      directoryCycles([
        { path: 'tools/a.ts', text: "import '../server-deps.js'\n" },
        { path: 'server-deps.ts', text: "import type {} from './search/e.js'\n" },
        { path: 'search/e.ts', text: "import '../server-deps.js'\n" },
      ]),
    ).toEqual([])
  })
})

describe('server-core layer order', () => {
  const actual = upwardEdges(FILES)

  it('scans every layer', () => {
    // A walk that matched nothing, or a classifier that put everything in one
    // layer, passes every assertion below for the wrong reason.
    expect(FILES.length, 'the source walk found almost nothing').toBeGreaterThan(60)
    for (const layer of LAYERS) {
      expect(
        FILES.filter(({ path }) => layerOf(path) === layer).length,
        `no production module is filed under ${layer}`,
      ).toBeGreaterThan(0)
    }
    expect(edgesOf(FILES).length, 'no import resolved').toBeGreaterThan(100)
  })

  it('files every production module in a layer', () => {
    const unfiled = FILES.filter(({ path }) => layerOf(path) === undefined).map(({ path }) => path)
    expect(
      unfiled,
      'a module belongs to no layer — a new root `*.ts` is named in ROOT_FILES, and a new ' +
        'directory in DIRECTORY_LAYERS',
    ).toEqual([])
  })

  it('names only directories and root files that still exist', () => {
    const paths = new Set(FILES.map(({ path }) => path))
    const dirs = new Set(FILES.map(({ path }) => path.split('/')[0]))
    expect(Object.keys(ROOT_FILES).filter((path) => !paths.has(path))).toEqual([])
    expect(Object.keys(DIRECTORY_LAYERS).filter((dir) => !dirs.has(dir))).toEqual([])
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
    expect(Object.keys(UPWARD_EDGES)).toHaveLength(UPWARD_EDGES_CEILING)
  })

  it('has no loop among its directories', () => {
    expect(directoryCycles(FILES)).toEqual([])
  })
})
