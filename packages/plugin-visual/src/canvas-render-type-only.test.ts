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

const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('imports from canvas-render', () => {
  it('are type-only, in every source file', () => {
    const offenders: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) continue
      for (const line of String(source).split('\n')) {
        if (!line.includes('@kamiazya/whiteboard-canvas-render')) continue
        if (!line.trimStart().startsWith('import')) continue
        // `import type { … }` is the whole statement; `import { type A }` is
        // a value import that happens to carry type specifiers, and one
        // added value specifier beside them closes the cycle.
        if (!line.trimStart().startsWith('import type ')) offenders.push(`${path}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
