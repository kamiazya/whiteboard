// The scan helpers memoise what they derive from a file, per worker, and this
// project runs with `isolate: false` — so a caller that edits an answer it was
// handed would change what every later guard in the worker reads. Each memo
// hands out a copy, and is keyed by the file name as well as the text.
import { describe, expect, it } from 'vitest'
import { collectRelativeImportEdges } from './cycle-check.js'
import { commentRanges } from './strip-comments.js'

describe('commentRanges', () => {
  const source = 'const a = 1 // one\n/* two */ f()\n'

  it('answers the same ranges after a caller edits the ones it was handed', () => {
    const first = commentRanges(source, 'memo-copy.ts')
    const expected = first.map(([start, end]) => [start, end])
    first.splice(0, first.length)
    expect(commentRanges(source, 'memo-copy.ts')).toEqual(expected)
    expect(expected).toHaveLength(2)
  })

  it('reads the same text by the grammar its file name asks for', () => {
    // In `.tsx` the `//` sits in JSX text and is no comment; in `.ts` the `<p>`
    // is a type assertion and the `//` starts one.
    const jsx = 'const a = <p>x // y</p>\n'
    expect(commentRanges(jsx, 'memo-grammar.ts')).not.toEqual(
      commentRanges(jsx, 'memo-grammar.tsx'),
    )
  })
})

describe('collectRelativeImportEdges', () => {
  const source = "import { a } from './a.js'\nimport b from 'b'\nexport * from '../c.js'\n"

  it('answers the same edges after a caller edits the list it was handed', () => {
    const first = collectRelativeImportEdges('memo-edges.ts', source)
    expect(first.map(({ specifier }) => specifier)).toEqual(['./a.js', '../c.js'])
    first.splice(0, first.length)
    expect(
      collectRelativeImportEdges('memo-edges.ts', source).map(({ specifier }) => specifier),
    ).toEqual(['./a.js', '../c.js'])
  })
})
