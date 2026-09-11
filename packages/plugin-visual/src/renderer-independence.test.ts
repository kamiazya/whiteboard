// `canvas-render` depends on this package at RUNTIME — it supplies this
// plugin's shapes and its render contribution as defaults. So an import back
// closes a package cycle, and this package must not have one AT ALL.
//
// It used to have one, held open only by every import back being type-only:
// a property no manifest can see, which is why this guard existed and why
// the pair sat in arch-lint's KNOWN_PACKAGE_CYCLES. The contract now lives
// in `@kamiazya/whiteboard-scene`, below both, so there is nothing to hold
// open — and the invariant gets STRONGER rather than retiring: not "the
// edge is type-only" but "there is no edge".
//
// Kept scanning declarations rather than lines, because a line scan misses
// the two ways an edge actually arrives: a MULTILINE import, whose line
// carrying the package name starts with no keyword at all, and a re-export,
// which never starts with `import`. Both left the first version green.
//
// Read with `?raw` rather than `node:fs`: this package must stay runnable
// wherever its data half runs.
import { describe, expect, it } from 'vitest'

const PACKAGE = '@kamiazya/whiteboard-canvas-render'

/**
 * Every static `import`/`export … from '<PACKAGE>'` declaration, type-only
 * or not. A type-only edge is erased at runtime and closes no cycle, but it
 * is still this package knowing the renderer — which the contract package
 * exists to make unnecessary.
 */
export function importsOf(source: string, packageName: string): string[] {
  const pattern = new RegExp(
    String.raw`(^|\n)[ \t]*(import|export)\b([\s\S]*?)from[ \t]*['"]` +
      packageName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`) +
      `['"]`,
    'g',
  )
  const offenders: string[] = []
  for (const match of source.matchAll(pattern)) {
    const [declaration, , keyword] = match
    offenders.push(`${keyword}: ${declaration.trim().replace(/\s+/g, ' ')}`)
  }
  return offenders
}

const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('the guard itself', () => {
  it('catches a type-only import, on one line or several', () => {
    expect(importsOf(`import type { A } from '${PACKAGE}'`, PACKAGE)).toHaveLength(1)
    expect(importsOf(`import type {\n  A,\n  B,\n} from '${PACKAGE}'`, PACKAGE)).toHaveLength(1)
  })

  it('catches a MULTILINE import', () => {
    // The line naming the package is `} from '…'` — no keyword on it at all.
    expect(
      importsOf(`import {\n  type A,\n  sceneBounds,\n} from '${PACKAGE}'`, PACKAGE),
    ).toHaveLength(1)
  })

  it('catches a RE-EXPORT, which never starts with import', () => {
    expect(importsOf(`export { sceneBounds } from '${PACKAGE}'`, PACKAGE)).toHaveLength(1)
    expect(importsOf(`export * from '${PACKAGE}'`, PACKAGE)).toHaveLength(1)
  })

  it('ignores another package', () => {
    expect(importsOf(`import { x } from '@kamiazya/whiteboard-model'`, PACKAGE)).toEqual([])
  })

  it('finds the sources it is meant to scan', () => {
    // A glob that stopped matching would report "no offenders" — which reads
    // exactly like a package that stopped importing the renderer.
    expect(Object.keys(sources).length).toBeGreaterThan(4)
  })
})

describe('imports from canvas-render', () => {
  it('do not exist, in any source file: the contract comes from below', () => {
    const offenders: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) continue
      for (const found of importsOf(String(source), PACKAGE)) {
        offenders.push(`${path}: ${found}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
