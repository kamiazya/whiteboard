/**
 * A `useRef` nothing reads is not kept, in shipped web-app and package source.
 *
 * Biome's unused-variable rule cannot see one: the `x.current = …` write
 * counts as a use. So a ref outlives the read it was made for, and the
 * comment above it goes on describing a design the code no longer follows —
 * one claimed a hook's backend was kept out of an effect's dependencies when
 * it was in fact the dependency that reconnects it.
 *
 * Read from the syntax tree, so a comment or string naming the ref is not a
 * read.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writtenNeverReadRefs } from './dead-ref-scan.js'
import { REPO_ROOT } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

function shippedSource(): readonly string[] {
  return [
    ...walkSourceFiles(join(REPO_ROOT, 'packages')),
    ...walkSourceFiles(join(REPO_ROOT, 'apps/web/src')),
  ]
    .map((absolute) => relative(REPO_ROOT, absolute).split(sep).join('/'))
    .filter((path) => /^(packages\/[^/]+|apps\/web)\/src\//.test(path) && isShippedPath(path))
}

const files = shippedSource()

describe('a ref nothing reads is not kept', () => {
  it('scans a tree worth scanning', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.filter((path) => path.startsWith('apps/web/src/')).length).toBeGreaterThan(300)
  })

  it('every useRef is read somewhere besides its own `.current =` writes', () => {
    const dead = files.flatMap((path) =>
      writtenNeverReadRefs(path, readFileSync(join(REPO_ROOT, path), 'utf8')).map(
        (name) => `${path}: ${name}`,
      ),
    )
    expect(dead, 'delete the ref, and the comment that explains a read it no longer has').toEqual(
      [],
    )
  })

  describe('the scan itself, on planted source', () => {
    const dead = (source: string) => writtenNeverReadRefs('planted.tsx', source)

    it('reports a ref only ever written', () => {
      expect(dead('const a = useRef(0)\na.current = 1')).toEqual(['a'])
      expect(dead('const b = React.useRef<number>(0)\nb.current = 2')).toEqual(['b'])
      expect(dead('const c = useRef(null)')).toEqual(['c'])
    })

    it('counts a read, a ref prop and a compound write as uses', () => {
      expect(dead('const a = useRef(0)\na.current = 1\nconsole.log(a.current)')).toEqual([])
      expect(dead('const a = useRef(null)\nconst el = <div ref={a} />')).toEqual([])
      expect(dead('const a = useRef(0)\na.current += 1')).toEqual([])
      expect(dead('const a = useRef({ n: 0 })\na.current.n = 1')).toEqual([])
    })

    it('sees a read written above the declaration', () => {
      expect(dead('const f = () => a.current\nconst a = useRef(0)')).toEqual([])
    })

    it('ignores a name that only a comment or a string carries', () => {
      expect(dead("const a = useRef(0)\na.current = 1\n// a.current\nconst s = 'a'")).toEqual(['a'])
    })

    it('does not count a property NAME spelled like the ref as a read', () => {
      const written = 'const a = useRef(0)\na.current = 1\n'
      expect(dead(`${written}const o = { a: 1 }`)).toEqual(['a'])
      expect(dead(`${written}const n = other.a`)).toEqual(['a'])
      expect(dead(`${written}const el = <div a={1} />`)).toEqual(['a'])
      expect(dead(`${written}const { a: b } = other`)).toEqual(['a'])
      expect(dead(`${written}class C { a = 1; a2() {} }`)).toEqual(['a'])
      // Shorthand IS a read: `{ a }` hands the ref itself over.
      expect(dead(`${written}const o = { a }`)).toEqual([])
    })

    it('ignores a binding that is not a ref', () => {
      expect(dead('const a = useState(0)\nconst b = makeRef()')).toEqual([])
    })
  })
})
