// @vitest-environment node
// The entry chunk's critical path is everything App.tsx reaches through
// STATIC imports: Vite modulepreloads each of those chunks from index.html,
// so a fresh visitor downloads them before first paint. loro-crdt's WASM
// bindings (and everything that imports them — the workspace-document
// machinery behind FoldingBrowserIndex) belong behind the React.lazy page
// boundary, where every page that needs them already lives.
//
// This walks App.tsx's static-import closure over src/ and fails when any
// module in it imports loro-crdt or the loro-adapter. The CI bundle-size
// gate (smoke-bundle-size.mjs) would also catch the regression, but only
// after a production build; this is the nearest-layer version of the same
// budget, and it names the offending module instead of a byte total.
// Measured: App.tsx statically importing FoldingBrowserIndex moved the
// critical path from ~114 KB to 158.9 KB gzip — loro's bindings plus the
// schema/store modules it drags in.

import { describe, expect, it } from 'vitest'

const RAW_SOURCES = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const BANNED =
  /^(loro-crdt|@kamiazya\/whiteboard-loro-adapter|@kamiazya\/whiteboard-workspace-index)/

/** Static import/export-from specifiers, with type-only edges erased the way tsc erases them. */
function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'"]*?)from\s+['"]([^'"]+)['"]/g,
  )) {
    if (match[2] !== undefined) continue // `import type` / `export type` — erased at build time
    specifiers.push(match[4] as string)
  }
  // Bare side-effect imports: `import './x.js'`
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1] as string)
  }
  return specifiers
}

/** Resolves a specifier from a glob key (`./pages/X.tsx`) to another glob key, or null for externals. */
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

describe('App.tsx static-import closure', () => {
  it('never reaches loro-crdt — the workspace-document machinery stays behind the lazy page boundary', () => {
    // The walk is only meaningful if the glob actually captured the tree.
    expect(Object.keys(RAW_SOURCES).length).toBeGreaterThan(100)
    expect('./App.tsx' in RAW_SOURCES).toBe(true)

    const visited = new Set<string>(['./App.tsx'])
    const queue = ['./App.tsx']
    const offenders: string[] = []
    while (queue.length > 0) {
      const key = queue.pop() as string
      const source = RAW_SOURCES[key] as string
      for (const specifier of staticImportSpecifiers(source)) {
        if (BANNED.test(specifier)) offenders.push(`${key} → ${specifier}`)
        const next = resolveLocal(key, specifier)
        if (next !== null && !visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }

    // The closure is real (App reaches its lib modules), not a broken resolver
    // that visited nothing and passed vacuously. The entry closure is SMALL by
    // design — every page is React.lazy — so the floor guards resolver
    // breakage, not closure size (16 modules when this landed).
    expect(visited.size).toBeGreaterThan(10)
    expect(
      offenders,
      `these static edges put loro on the first-paint critical path; load the module from a lazy page instead: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
