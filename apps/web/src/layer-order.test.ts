/**
 * `apps/web/src` has layers, and until this test it had them only by
 * convention: `lib/` (browser-only mechanics, no React), `contexts/` and
 * `hooks/` (React state over lib), `components/`, `pages/`, and the
 * composition at the root (`App.tsx`, `boot.ts`, `main.tsx`). Every edge
 * should point DOWN that order — a page may use a hook, a hook may use lib;
 * lib importing a component means the type or helper lib wanted was filed
 * under the screen that first needed it and never moved.
 *
 * Measured before writing this: 21 upward edges, 15 of them `import type`;
 * the first burn-down moved four pure modules into `lib/` and retired six.
 * They are allowlisted below rather than fixed here, because each is a
 * relocation with its own importers to carry, and the point of the guard is
 * that the count only ever goes down. The list is guarded from both sides —
 * an entry that stops being a real edge fails, and the length is pinned by
 * equality — the way `adapter-mechanic-check.ts` holds ADR-0018's debt.
 *
 * Type-only edges COUNT. tsc erases them, so the bundle never sees the
 * inversion, but layering is about what a module has to know: a lib module
 * that names `EditorCommand` from a component is a lib module whose contract
 * is defined above it. They are tagged so the burn-down can read which are
 * a type move and which are a helper move.
 *
 * Sources are read via `?raw` glob, not `node:fs` — apps/web is browser-only
 * (the same reason `entry-graph-loro-free.test.ts` reads them that way).
 */

import { describe, expect, it } from 'vitest'

const RAW_SOURCES = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Bottom to top. A module may import from its own layer or any layer before it. */
const LAYERS = ['lib', 'pwa', 'contexts', 'hooks', 'components', 'pages', 'app'] as const
type Layer = (typeof LAYERS)[number]

/**
 * Root-level modules are the composition — except `runtime-config.ts`, a
 * zod config leaf that README and ADR-0002 name at the root, so it stays
 * there and is filed with lib, which is what it is.
 */
const ROOT_MODULES: Record<string, Layer> = {
  './runtime-config.ts': 'lib',
  './App.tsx': 'app',
  './boot.ts': 'app',
  './boot-splash.ts': 'app',
  './main.tsx': 'app',
  './_type-probe.ts': 'app',
}

/** Test support and doc snapshots: setup for tests, not part of the app's graph. */
const EXEMPT_DIRS = ['./test-utils/', './test-config/', './docs-snapshots/']

const isTest = (key: string): boolean => key.includes('.test.')

function layerOf(key: string): Layer | undefined {
  if (isTest(key) || EXEMPT_DIRS.some((d) => key.startsWith(d))) return undefined
  const root = ROOT_MODULES[key]
  if (root !== undefined) return root
  return LAYERS.find((layer) => key.startsWith(`./${layer}/`))
}

/** Static import/export-from specifiers, each tagged with whether tsc erases it. */
function staticImports(source: string): { specifier: string; typeOnly: boolean }[] {
  const edges: { specifier: string; typeOnly: boolean }[] = []
  for (const match of source.matchAll(
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'"]*?)from\s+['"]([^'"]+)['"]/g,
  )) {
    edges.push({ specifier: match[4] as string, typeOnly: match[2] !== undefined })
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
    edges.push({ specifier: match[1] as string, typeOnly: false })
  }
  return edges
}

/** Resolves a specifier from a glob key to another glob key, or null for externals and assets. */
function resolveLocal(fromKey: string, specifier: string): string | null {
  let path: string
  if (specifier.startsWith('@/')) {
    path = `./${specifier.slice(2)}`
  } else if (specifier.startsWith('.')) {
    const dir = fromKey.split('/').slice(0, -1)
    for (const segment of specifier.split('/')) {
      if (segment === '.') continue
      if (segment === '..') dir.pop()
      else dir.push(segment)
    }
    path = dir.join('/')
  } else {
    return null
  }
  const stems = [path, path.replace(/\.js$/, '')]
  const candidates = stems.flatMap((stem) => [
    stem,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}/index.ts`,
    `${stem}/index.tsx`,
  ])
  return candidates.find((candidate) => candidate in RAW_SOURCES) ?? null
}

/** `./lib/x.ts -> ./hooks/y.ts (type)`, in the strings the allowlist is written in. */
function upwardEdges(): string[] {
  const rank = (layer: Layer): number => LAYERS.indexOf(layer)
  const edges: string[] = []
  for (const [key, source] of Object.entries(RAW_SOURCES)) {
    const from = layerOf(key)
    if (from === undefined) continue
    for (const { specifier, typeOnly } of staticImports(source)) {
      const target = resolveLocal(key, specifier)
      if (target === null) continue
      const to = layerOf(target)
      if (to === undefined || rank(to) <= rank(from)) continue
      edges.push(`${key.slice(2)} -> ${target.slice(2)}${typeOnly ? ' (type)' : ''}`)
    }
  }
  return edges.sort()
}

/**
 * Every upward edge that exists today, each a relocation still to do. Shrink
 * it by moving the target down (a type into `lib/`, a pure helper out of
 * `components/`), then delete the line and lower the ceiling. Never add to
 * it for new code — file the module where its importers can reach it.
 */
const UPWARD_EDGES: readonly string[] = [
  'components/SaveStatusChip.tsx -> pages/use-browser-document-controller.ts (type)',
  'hooks/useDocumentSync.ts -> components/spatial-editor/commands.ts (type)',
  'hooks/useDocumentSync.ts -> components/spatial-editor/scene-render.ts',
  'lib/daemon-file-adapter.ts -> hooks/use-document-file-seams.ts (type)',
  'lib/document-embed-content.ts -> hooks/use-document-file-seams.ts (type)',
  'lib/document-sync-session.ts -> components/spatial-editor/commands.ts (type)',
  'lib/favicon.ts -> components/spatial-editor/minimap.ts',
  'lib/initial-tool.ts -> components/spatial-editor/ToolPalette.tsx (type)',
  'lib/layout-worker-protocol.ts -> hooks/useThemeMode.ts (type)',
  'lib/layout-worker.ts -> components/markdown-editor/render-preview.ts',
  'lib/layout-worker.ts -> components/spatial-editor/scene-render-core.ts',
  'lib/layout-worker.ts -> hooks/useThemeMode.ts (type)',
  'lib/render-key.ts -> hooks/useThemeMode.ts (type)',
  'lib/shell-status-store.ts -> components/connection/ConnectionStatus.tsx (type)',
  'lib/viewport-request.ts -> components/spatial-editor/index.ts (type)',
]

const UPWARD_EDGES_CEILING = 15

describe('apps/web layer order', () => {
  const actual = upwardEdges()

  it('scans every layer', () => {
    // A guard over a glob that matched nothing passes for the wrong reason.
    expect(Object.keys(RAW_SOURCES).length).toBeGreaterThan(100)
    for (const layer of LAYERS) {
      const inLayer = Object.keys(RAW_SOURCES).filter((key) => layerOf(key) === layer)
      expect(inLayer.length, `no production modules filed under ${layer}`).toBeGreaterThan(0)
    }
    for (const key of Object.keys(RAW_SOURCES)) {
      if (isTest(key) || EXEMPT_DIRS.some((d) => key.startsWith(d))) continue
      expect(
        layerOf(key),
        `${key} belongs to no layer — file it, or name it in ROOT_MODULES`,
      ).toBeDefined()
    }
  })

  it('has no upward edge outside the allowlist', () => {
    const unexpected = actual.filter((edge) => !UPWARD_EDGES.includes(edge))
    expect(
      unexpected,
      'a module imports from a layer above it — move what it needs down rather than adding to the allowlist',
    ).toEqual([])
  })

  it('every allowlist entry is still a real edge', () => {
    const stale = UPWARD_EDGES.filter((edge) => !actual.includes(edge))
    expect(stale, 'an entry that outlives its edge is how an allowlist stops being read').toEqual(
      [],
    )
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(UPWARD_EDGES.length).toBe(UPWARD_EDGES_CEILING)
  })
})
