import { describe, expect, it } from 'vitest'
import { directoryLoops, resolvedImportEdges, spellLoop } from './directory-loops.js'

const unitOf = (path: string): string | undefined => path.split('/')[0]
const edge = (from: string, to: string) => ({ from, to })

describe('directoryLoops', () => {
  it('finds no loop in a one-way chain, however many directories it crosses', () => {
    expect(directoryLoops([edge('a/x.ts', 'b/x.ts'), edge('b/x.ts', 'c/x.ts')], unitOf)).toEqual([])
  })

  it('does not call a directory importing itself a loop', () => {
    expect(directoryLoops([edge('a/x.ts', 'a/y.ts'), edge('a/y.ts', 'a/x.ts')], unitOf)).toEqual([])
  })

  it('names every disjoint loop, in order, each with its members sorted', () => {
    const loops = directoryLoops(
      [
        edge('z/x.ts', 'y/x.ts'),
        edge('y/x.ts', 'z/x.ts'),
        edge('b/x.ts', 'a/x.ts'),
        edge('a/x.ts', 'b/x.ts'),
      ],
      unitOf,
    )
    expect(loops.map((loop) => loop.members)).toEqual([
      ['a', 'b'],
      ['y', 'z'],
    ])
    expect(loops.map(spellLoop)).toEqual(['a,b', 'y,z'])
  })

  it('folds a three-directory ring into one component, members sorted', () => {
    const loops = directoryLoops(
      [edge('c/x.ts', 'a/x.ts'), edge('a/x.ts', 'b/x.ts'), edge('b/x.ts', 'c/x.ts')],
      unitOf,
    )
    expect(loops).toEqual([{ members: ['a', 'b', 'c'], edges: 3 }])
  })

  it('leaves a directory that only feeds the loop out of it', () => {
    const loops = directoryLoops(
      [edge('a/x.ts', 'b/x.ts'), edge('b/x.ts', 'a/x.ts'), edge('d/x.ts', 'a/x.ts')],
      unitOf,
    )
    expect(loops).toEqual([{ members: ['a', 'b'], edges: 2 }])
  })

  it('counts distinct file-to-file imports, not directory pairs and not repeats', () => {
    const loops = directoryLoops(
      [
        edge('a/one.ts', 'b/one.ts'),
        edge('a/one.ts', 'b/one.ts'),
        edge('a/two.ts', 'b/one.ts'),
        edge('b/one.ts', 'a/one.ts'),
        edge('a/one.ts', 'a/two.ts'),
      ],
      unitOf,
    )
    expect(loops).toEqual([{ members: ['a', 'b'], edges: 3 }])
  })

  it('skips a file that belongs to no directory', () => {
    const only = (path: string): string | undefined =>
      path.startsWith('root') ? undefined : unitOf(path)
    expect(directoryLoops([edge('a/x.ts', 'root.ts'), edge('root.ts', 'a/x.ts')], only)).toEqual([])
  })

  it('orders components by their joined member names, whatever order the edges came in', () => {
    const forward = [
      edge('m/x.ts', 'n/x.ts'),
      edge('n/x.ts', 'm/x.ts'),
      edge('b/x.ts', 'c/x.ts'),
      edge('c/x.ts', 'b/x.ts'),
    ]
    expect(directoryLoops(forward, unitOf).map(spellLoop)).toEqual(['b,c', 'm,n'])
    expect(directoryLoops([...forward].reverse(), unitOf).map(spellLoop)).toEqual(['b,c', 'm,n'])
  })
})

describe('resolvedImportEdges', () => {
  it('keeps the edges that resolve to a scanned file, type-only ones marked', () => {
    const edges = resolvedImportEdges([
      {
        path: 'a/x.ts',
        text: "import { y } from '../b/y.js'\nimport type { Z } from '../b/z.js'\nimport { q } from '../elsewhere/q.js'",
      },
      { path: 'b/y.ts', text: '' },
      { path: 'b/z.ts', text: '' },
    ])
    expect(edges).toEqual([
      { from: 'a/x.ts', to: 'b/y.ts', typeOnly: false },
      { from: 'a/x.ts', to: 'b/z.ts', typeOnly: true },
    ])
  })
})
