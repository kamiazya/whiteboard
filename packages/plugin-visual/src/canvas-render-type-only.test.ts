// `canvas-render` depends on this package at RUNTIME — it supplies this
// plugin's shapes and decorations as its defaults. So every import back must
// be type-only, or the two close a runtime cycle.
//
// Nothing else catches this. arch-lint's cycle check is intra-package, and
// its direction check reads `dependencies` only — canvas-render sits in this
// package's devDependencies precisely because the edge is types. Verified by
// mutation: turning the import into a value import left all 102 arch-lint
// tests green.
//
// Read with `?raw` rather than `node:fs`: this package must stay runnable
// wherever its data half runs.
import { describe, expect, it } from 'vitest'

const PACKAGE = '@kamiazya/whiteboard-canvas-render'

/**
 * Every static `import`/`export … from '<PACKAGE>'` declaration that is NOT
 * type-only.
 *
 * Declaration-shaped rather than line-shaped, because a line scan misses the
 * two ways a runtime edge actually arrives: a MULTILINE import, whose line
 * carrying the package name is the closing `} from '…'` and starts with no
 * keyword at all, and a re-export, which is a value edge and never starts
 * with `import`. Both left the first version of this guard green.
 */
export function valueImportsOf(source: string, packageName: string): string[] {
  const pattern = new RegExp(
    String.raw`(^|\n)[ \t]*(import|export)\b([\s\S]*?)from[ \t]*['"]` +
      packageName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`) +
      `['"]`,
    'g',
  )
  const offenders: string[] = []
  for (const match of source.matchAll(pattern)) {
    const [declaration, , keyword, clause] = match
    // `import type { … }` / `export type { … }` is the whole statement.
    // `import { type A }` is a VALUE import carrying type specifiers, and one
    // value specifier beside them closes the cycle.
    if (/^[ \t]*type\b/.test(clause ?? '')) continue
    offenders.push(`${keyword}: ${declaration.trim().replace(/\s+/g, ' ')}`)
  }
  return offenders
}

const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('the cycle guard itself', () => {
  it('accepts a type-only import, on one line or several', () => {
    expect(valueImportsOf(`import type { A } from '${PACKAGE}'`, PACKAGE)).toEqual([])
    expect(valueImportsOf(`import type {\n  A,\n  B,\n} from '${PACKAGE}'`, PACKAGE)).toEqual([])
  })

  it('catches a MULTILINE value import', () => {
    // The line naming the package is `} from '…'` — no keyword on it at all.
    expect(
      valueImportsOf(`import {\n  type A,\n  sceneBounds,\n} from '${PACKAGE}'`, PACKAGE),
    ).toHaveLength(1)
  })

  it('catches a value RE-EXPORT, which never starts with import', () => {
    expect(valueImportsOf(`export { sceneBounds } from '${PACKAGE}'`, PACKAGE)).toHaveLength(1)
    expect(valueImportsOf(`export * from '${PACKAGE}'`, PACKAGE)).toHaveLength(1)
  })

  it('leaves a type-only re-export alone', () => {
    expect(valueImportsOf(`export type { A } from '${PACKAGE}'`, PACKAGE)).toEqual([])
  })

  it('ignores another package', () => {
    expect(valueImportsOf(`import { x } from '@kamiazya/whiteboard-model'`, PACKAGE)).toEqual([])
  })
})

describe('imports from canvas-render', () => {
  it('are type-only, in every source file', () => {
    const offenders: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) continue
      for (const found of valueImportsOf(String(source), PACKAGE)) {
        offenders.push(`${path}: ${found}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
