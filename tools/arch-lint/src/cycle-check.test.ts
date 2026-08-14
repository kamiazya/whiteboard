import { describe, expect, it } from 'vitest'
import {
  buildValueImportGraph,
  collectRelativeImportEdges,
  findImportCycles,
} from './cycle-check.js'

function file(path: string, text: string): { path: string; text: string } {
  return { path, text }
}

describe('findImportCycles', () => {
  it('reports a 2-node cycle', () => {
    const graph = new Map([
      ['a.ts', ['b.ts']],
      ['b.ts', ['a.ts']],
    ])
    expect(findImportCycles(graph)).toEqual([['a.ts', 'b.ts']])
  })

  it('reports a 3-node cycle', () => {
    const graph = new Map([
      ['a.ts', ['b.ts']],
      ['b.ts', ['c.ts']],
      ['c.ts', ['a.ts']],
    ])
    expect(findImportCycles(graph)).toEqual([['a.ts', 'b.ts', 'c.ts']])
  })

  it('reports nothing for an acyclic diamond', () => {
    const graph = new Map([
      ['a.ts', ['b.ts', 'c.ts']],
      ['b.ts', ['d.ts']],
      ['c.ts', ['d.ts']],
      ['d.ts', []],
    ])
    expect(findImportCycles(graph)).toEqual([])
  })

  it('reports a self-import as a one-element group', () => {
    const graph = new Map([['a.ts', ['a.ts']]])
    expect(findImportCycles(graph)).toEqual([['a.ts']])
  })

  it('is deterministic under input file-order permutation (metamorphic)', () => {
    const forward = new Map([
      ['a.ts', ['b.ts']],
      ['b.ts', ['c.ts']],
      ['c.ts', ['a.ts']],
      ['d.ts', []],
    ])
    const shuffled = new Map([
      ['d.ts', []],
      ['c.ts', ['a.ts']],
      ['a.ts', ['b.ts']],
      ['b.ts', ['c.ts']],
    ])
    expect(findImportCycles(shuffled)).toEqual(findImportCycles(forward))
  })
})

describe('collectRelativeImportEdges: value-awareness', () => {
  it('does not flag a whole-declaration `import type`', () => {
    const edges = collectRelativeImportEdges('a.ts', "import type { X } from './b.js'")
    expect(edges).toHaveLength(1)
    expect(edges[0]?.typeOnly).toBe(true)
  })

  it('does not flag an all-inline-`type` named import', () => {
    const edges = collectRelativeImportEdges('a.ts', "import { type X } from './b.js'")
    expect(edges[0]?.typeOnly).toBe(true)
  })

  it('flags a mixed value + inline-type named import as a value edge', () => {
    const edges = collectRelativeImportEdges('a.ts', "import { type X, y } from './b.js'")
    expect(edges[0]?.typeOnly).toBe(false)
  })

  it('flags an un-annotated named import of a type (documented syntactic limitation)', () => {
    // Conservative-by-design: the checker does not run the type checker, so a
    // plain named import that TS would elide as type-only at emit still reads
    // as a value edge here. This can over-report but never under-report.
    const edges = collectRelativeImportEdges('a.ts', "import { X } from './b.js'")
    expect(edges[0]?.typeOnly).toBe(false)
  })

  it('treats `export { y } from` as a value edge and `export type { X } from` as type-only', () => {
    const valueEdges = collectRelativeImportEdges('a.ts', "export { y } from './b.js'")
    expect(valueEdges[0]?.typeOnly).toBe(false)

    const typeEdges = collectRelativeImportEdges('a.ts', "export type { X } from './b.js'")
    expect(typeEdges[0]?.typeOnly).toBe(true)
  })

  it('treats a dynamic `await import()` as a value edge', () => {
    const edges = collectRelativeImportEdges(
      'a.ts',
      "async function f() { await import('./b.js') }",
    )
    expect(edges[0]?.typeOnly).toBe(false)
  })

  it('ignores a bare (non-relative) specifier', () => {
    const edges = collectRelativeImportEdges('a.ts', "import { z } from 'zod'")
    expect(edges).toHaveLength(0)
  })
})

describe('buildValueImportGraph: path resolution', () => {
  it('resolves ./x.js and ./x.js->x.tsx, ./x and ./dir/index.ts, ignoring bare and unresolvable specifiers', () => {
    const files = [
      file(
        'src/a.ts',
        "import { b } from './b.js'\nimport { z } from 'zod'\nimport { g } from './ghost.js'",
      ),
      file('src/b.ts', 'export const b = 1'),
      file('src/c.tsx', "import { d } from './d'"),
      file('src/d.tsx', 'export const d = 1'),
      file('src/e.ts', "import { i } from './views'"),
      file('src/views/index.ts', 'export const i = 1'),
    ]
    const graph = buildValueImportGraph(files)
    expect(graph.get('src/a.ts')).toEqual(['src/b.ts'])
    expect(graph.get('src/c.tsx')).toEqual(['src/d.tsx'])
    expect(graph.get('src/e.ts')).toEqual(['src/views/index.ts'])
  })

  it('does not throw on an unresolvable relative specifier', () => {
    const files = [file('src/a.ts', "import { x } from './missing.js'")]
    expect(() => buildValueImportGraph(files)).not.toThrow()
    expect(buildValueImportGraph(files).get('src/a.ts')).toEqual([])
  })

  it('drops type-only edges from the graph', () => {
    const files = [
      file('src/a.ts', "import type { B } from './b.js'"),
      file('src/b.ts', 'export interface B { x: number }'),
    ]
    const graph = buildValueImportGraph(files)
    expect(graph.get('src/a.ts')).toEqual([])
  })
})

describe('buildValueImportGraph + findImportCycles: end-to-end', () => {
  it('does not flag a cycle that is type-only in one direction', () => {
    const files = [
      file('src/a.ts', "import { b } from './b.js'"),
      file('src/b.ts', "import type { A } from './a.js'\nexport const b = 1"),
    ]
    expect(findImportCycles(buildValueImportGraph(files))).toEqual([])
  })

  it('flags a genuine bidirectional value cycle', () => {
    const files = [
      file('src/a.ts', "import { b } from './b.js'"),
      file('src/b.ts', "import { a } from './a.js'"),
    ]
    expect(findImportCycles(buildValueImportGraph(files))).toEqual([['src/a.ts', 'src/b.ts']])
  })
})
