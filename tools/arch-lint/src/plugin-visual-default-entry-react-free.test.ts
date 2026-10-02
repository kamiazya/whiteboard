/**
 * `plugin-visual`'s data and render halves must not load React.
 *
 * The package legitimately lists `react`, `lucide-react` and
 * `@kamiazya/whiteboard-facet-ui`, because `/ui` is a React package — so the
 * allowed-dependency check, which judges the package as a whole, can never
 * say no to one. But `canvas-render` imports the DEFAULT entry for its shapes
 * and `/render` for the render contribution, which puts that closure in the
 * Node export path and the layout worker. One data module that grows a React
 * import there ships React into both, and nothing fails: the import is
 * allowed, the types are fine, and only a built bundle shows it.
 *
 * So this walks the VALUE-import closure of every published entry except the
 * declared React one, and fails on `react`, `react-dom`, `lucide-react`,
 * `@kamiazya/whiteboard-facet-ui`, or any `.tsx` file.
 *
 * Type-only imports are NOT banned: they are erased at emit, so they add
 * nothing to what Node or the worker loads. (They do still make the package
 * know React's types, which is why the `/ui` entry is the only place the
 * manifest's `@types/react` is needed.) `renderer-independence.test.ts` pins
 * the opposite edge — no import of the renderer at all, type-only included —
 * and this scan does not repeat it.
 *
 * Entries are read from the manifest's `exports`, so a subpath added later is
 * covered without anyone remembering this file.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import {
  type ClosureHost,
  resolveRelativeSource,
  walkValueImportClosure,
} from './value-import-closure.js'

const PACKAGE_DIR = join(REPO_ROOT, 'packages', 'plugin-visual')

/** The one subpath that is React by design; its own scan below proves it still is. */
const REACT_ENTRY = './ui'

const REACT_MODULES = new Set([
  'react',
  'react-dom',
  'lucide-react',
  '@kamiazya/whiteboard-facet-ui',
])

/** `react/jsx-runtime`, `react-dom/client` and the like are React too. */
function isReactSpecifier(specifier: string): boolean {
  if (REACT_MODULES.has(specifier)) return true
  const [scopeOrName, maybeName] = specifier.split('/')
  const packageName = scopeOrName?.startsWith('@') ? `${scopeOrName}/${maybeName}` : scopeOrName
  return REACT_MODULES.has(packageName as string)
}

interface ReactEdge {
  readonly file: string
  readonly what: string
  readonly via: readonly string[]
}

/** Every way the closure of `entries` reaches React: a bare import, or a `.tsx` file. */
function reactEdgesFrom(entries: readonly string[], host: ClosureHost): ReactEdge[] {
  const { files, imports, chainTo } = walkValueImportClosure(entries, host)
  const edges: ReactEdge[] = []
  for (const reached of imports) {
    if (isReactSpecifier(reached.specifier)) {
      edges.push({
        file: reached.from,
        what: `imports '${reached.specifier}' (line ${reached.line})`,
        via: reached.via,
      })
    }
  }
  for (const file of files) {
    if (file.endsWith('.tsx')) edges.push({ file, what: 'is a .tsx file', via: chainTo(file) })
  }
  return edges
}

function fixtureHost(sources: Record<string, string>): ClosureHost {
  return {
    read: (path) => sources[path] ?? '',
    resolve: (from, specifier) => resolveRelativeSource(from, specifier, (p) => p in sources),
  }
}

describe('the guard itself', () => {
  it('finds a React import several modules down the closure, and names the way in', () => {
    const host = fixtureHost({
      'a/index.ts': `export * from './data.js'`,
      'a/data.ts': `import { pick } from './deep/pick.js'\nexport const x = pick`,
      'a/deep/pick.ts': `import { useState } from 'react'\nexport const pick = useState`,
    })
    expect(reactEdgesFrom(['a/index.ts'], host)).toEqual([
      {
        file: 'a/deep/pick.ts',
        what: "imports 'react' (line 1)",
        via: ['a/index.ts', 'a/data.ts', 'a/deep/pick.ts'],
      },
    ])
  })

  it('finds each React module and its subpaths, not a lookalike', () => {
    for (const specifier of [
      'react-dom/client',
      'react/jsx-runtime',
      'lucide-react',
      '@kamiazya/whiteboard-facet-ui',
      '@kamiazya/whiteboard-facet-ui/form',
    ]) {
      expect(isReactSpecifier(specifier), specifier).toBe(true)
    }
    for (const specifier of ['reactive-streams', '@kamiazya/whiteboard-facet-engine', 'zod']) {
      expect(isReactSpecifier(specifier), specifier).toBe(false)
    }
  })

  it('finds a .tsx module reached by a value import', () => {
    const host = fixtureHost({
      'a/index.ts': `export { Panel } from './panel.js'`,
      'a/panel.tsx': `export const Panel = 1`,
    })
    expect(reactEdgesFrom(['a/index.ts'], host)).toEqual([
      { file: 'a/panel.tsx', what: 'is a .tsx file', via: ['a/index.ts', 'a/panel.tsx'] },
    ])
  })

  it('does not count a type-only import, which is erased at emit', () => {
    const host = fixtureHost({
      'a/index.ts': `import type { ReactNode } from 'react'\nimport { type FC } from 'react'\nexport type T = ReactNode | FC`,
    })
    expect(reactEdgesFrom(['a/index.ts'], host)).toEqual([])
  })

  it('follows a re-export and a dynamic import, which never start with import', () => {
    const host = fixtureHost({
      'a/index.ts': `export * from './r.js'\nexport const lazy = () => import('./d.js')`,
      'a/r.ts': `export { createElement } from 'react'`,
      'a/d.ts': `import 'react-dom'`,
    })
    expect(reactEdgesFrom(['a/index.ts'], host).map((e) => e.file)).toEqual(['a/r.ts', 'a/d.ts'])
  })
})

interface ExportEntry {
  readonly subpath: string
  readonly file: string
}

function publishedEntries(): ExportEntry[] {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf-8')) as {
    exports: Record<string, string | { import?: string }>
  }
  const entries: ExportEntry[] = []
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const file = typeof target === 'string' ? target : target.import
    if (file === undefined || !/\.tsx?$/.test(file)) continue
    entries.push({ subpath, file: join(PACKAGE_DIR, file) })
  }
  return entries
}

const realHost: ClosureHost = {
  read: (path) => readFileSync(path, 'utf-8'),
  resolve: (from, specifier) =>
    resolveRelativeSource(from, specifier, (p) => existsSync(p) && statSync(p).isFile()),
}

const entries = publishedEntries()
const safeEntries = entries.filter((e) => e.subpath !== REACT_ENTRY)
const rel = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')

/**
 * Below this the walk has stopped following imports. Measured 2026-10-02:
 * 23 files reached from the seven non-React entries (the emoji and icon
 * catalogs, the stencil/tag/theme tables, data.ts). Set well under that —
 * the point is "not a handful", not a tight pin a legitimate deletion trips.
 */
const REACHED_FILE_FLOOR = 15

describe('plugin-visual keeps React out of the data and render halves', () => {
  it('reads its entries from the manifest and finds the React one', () => {
    expect(entries.map((e) => e.subpath)).toContain('.')
    expect(entries.map((e) => e.subpath)).toContain('./render')
    expect(entries.map((e) => e.subpath)).toContain(REACT_ENTRY)
    expect(safeEntries.length).toBeGreaterThanOrEqual(5)
    expect(safeEntries.every((e) => e.file.endsWith('.ts'))).toBe(true)
  })

  it('reaches a real population, so a walk that stops following imports fails', () => {
    const { files } = walkValueImportClosure(
      safeEntries.map((e) => e.file),
      realHost,
    )
    expect(files.length).toBeGreaterThan(REACHED_FILE_FLOOR)
  })

  it('imports no React module and no .tsx file from any non-React entry', () => {
    const offenders = reactEdgesFrom(
      safeEntries.map((e) => e.file),
      realHost,
    ).map((e) => `${rel(e.file)} ${e.what}; reached via ${e.via.map(rel).join(' -> ')}`)
    expect(offenders).toEqual([])
  })

  it('still finds React behind the declared React entry, or the exemption is stale', () => {
    const reactEntry = entries.find((e) => e.subpath === REACT_ENTRY)
    expect(reactEntry).toBeDefined()
    const edges = reactEdgesFrom([(reactEntry as ExportEntry).file], realHost)
    expect(edges.length).toBeGreaterThan(0)
  })
})
