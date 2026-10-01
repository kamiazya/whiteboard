import { describe, expect, it } from 'vitest'
import { buildValueImportGraph, findImportCycles } from './cycle-check.js'
import { findTypeOnlyCycles } from './type-cycle-check.js'

function file(path: string, text: string): { path: string; text: string } {
  return { path, text }
}

describe('findTypeOnlyCycles', () => {
  const closedByType = [
    file('src/a.ts', "import { b } from './b.js'\nexport const a = b"),
    file('src/b.ts', "import type { A } from './a.js'\nexport const b: A | 1 = 1"),
  ]

  it('finds a cycle closed by an `import type` edge that the value scan cannot see', () => {
    expect(findImportCycles(buildValueImportGraph(closedByType))).toEqual([])
    expect(findTypeOnlyCycles(closedByType)).toEqual([['src/a.ts', 'src/b.ts']])
  })

  it('finds one closed by an inline-`type` named import and by `export type from`', () => {
    const inline = [
      file('src/a.ts', "import { b } from './b.js'"),
      file('src/b.ts', "import { type A } from './a.js'"),
    ]
    const reexport = [
      file('src/a.ts', "import { b } from './b.js'"),
      file('src/b.ts', "export type { A } from './a.js'"),
    ]
    expect(findTypeOnlyCycles(inline)).toHaveLength(1)
    expect(findTypeOnlyCycles(reexport)).toHaveLength(1)
  })

  it('does not re-report a component the value scan already names', () => {
    const valueCycle = [
      file('src/a.ts', "import { b } from './b.js'"),
      file('src/b.ts', "import { a } from './a.js'"),
    ]
    expect(findImportCycles(buildValueImportGraph(valueCycle))).toHaveLength(1)
    expect(findTypeOnlyCycles(valueCycle)).toEqual([])
  })

  it('reports a value cycle widened by a type-only member as its own, larger component', () => {
    const widened = [
      file('src/a.ts', "import { b } from './b.js'"),
      file('src/b.ts', "import { a } from './a.js'\nimport type { C } from './c.js'"),
      file('src/c.ts', "import { a } from './a.js'"),
    ]
    expect(findTypeOnlyCycles(widened)).toEqual([['src/a.ts', 'src/b.ts', 'src/c.ts']])
  })

  it('reports nothing for a type edge that only points downhill', () => {
    const acyclic = [
      file('src/a.ts', "import type { B } from './b.js'"),
      file('src/b.ts', 'export interface B { x: number }'),
    ]
    expect(findTypeOnlyCycles(acyclic)).toEqual([])
  })

  it('follows a declared alias on a type edge', () => {
    const aliased = [
      file('src/a.ts', "import { b } from './b.js'"),
      file('src/b.ts', "import type { A } from '@/a.js'"),
    ]
    expect(findTypeOnlyCycles(aliased)).toEqual([])
    expect(findTypeOnlyCycles(aliased, { '@/': 'src/' })).toHaveLength(1)
  })
})
