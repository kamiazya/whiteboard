import { describe, expect, it } from 'vitest'
import { stripComments } from './strip-comments.js'

describe('stripComments', () => {
  it('keeps the code after a `//` inside a string literal', () => {
    const source = "const u = 'https://a.example'; localStorage.setItem('k', u)"
    expect(stripComments(source)).toBe(source)
  })

  it('keeps a glob whose pattern contains comment openers', () => {
    const source = "import.meta.glob('./**/*.ts', { query: '?raw' })"
    expect(stripComments(source)).toBe(source)
  })

  it('blanks line and block comments, keeping every offset and newline', () => {
    const source = 'a() // note\n/* one\ntwo */ b()\n'
    const stripped = stripComments(source)
    expect(stripped).toHaveLength(source.length)
    expect(stripped).toBe('a()        \n      \n       b()\n')
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length)
  })

  it('does not let an interpolated template flip what follows it', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test is a template literal
    const template = 'const t = `${a} // not a comment ${b}`;'
    const source = `${template} // a comment\nlocalStorage.clear()`
    expect(stripComments(source)).toBe(`${template}${' '.repeat(13)}\nlocalStorage.clear()`)
  })

  it('reads a quote inside a regex literal as part of the regex', () => {
    const source = "const q = /'/g; // trailing\nlocalStorage.clear()"
    expect(stripComments(source)).toBe("const q = /'/g;            \nlocalStorage.clear()")
  })

  it('treats a slash after an identifier as division, and after `return` as a regex', () => {
    expect(stripComments('const r = a / b // c')).toBe('const r = a / b     ')
    expect(stripComments("return /'/.test(s) // c")).toBe("return /'/.test(s)     ")
  })
})
