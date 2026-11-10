import { describe, expect, it } from 'vitest'
import { parseOkf, serializeOkf } from './okf-core.js'

const yamlStage = (text: string): string => {
  const result = parseOkf(`---\n${text}\n---\nbody\n`)
  return !result.ok && result.error.stage === 'yaml' ? result.error.message : ''
}

/** What `type: note` plus `text` reads as, in the bucket unknown keys keep. */
const readAs = (text: string): unknown => {
  const result = parseOkf(`---\ntype: note\n${text}\n---\nbody\n`)
  if (!result.ok) throw new Error(`${result.error.stage}: ${result.error.message}`)
  return result.value.frontmatter.facetsRaw
}

// The core names the class of a YAML refusal, not the fault the `yaml` package
// worded (owner decision q25), so each refusal is held to its class.
const SUBSET = /^malformed YAML frontmatter: the YAML is outside the subset the reader accepts$/

// What the reader gets is the text between the fences, so a closing marker
// with text after it (`--- b`) is the fence and a body, never a refusal.
describe('the frontmatter YAML subset: what the reader refuses', () => {
  it.each([
    ['a local tag', 'a: !foo x'],
    ['a core tag', 'a: !!str 1'],
    ['a tag on a mapping', 'a: !!map\n  b: 1'],
    ['a tag on a list item', 'a:\n  - !!str 1'],
    ['a set tag', 'a: !!set\n  ? x'],
    ['a binary tag', 'a: !!binary aGk='],
  ])('refuses %s', (_label, text) => {
    expect(yamlStage(text)).toMatch(SUBSET)
  })

  it.each([
    ['a document start marker', '---\na: 1'],
    ['a document end marker', 'a: 1\n...'],
    ['a directive', '%YAML 1.2\n---\na: 1'],
    ['a directive with no marker', '%YAML 1.2\na: 1'],
  ])('refuses %s', (_label, text) => {
    expect(yamlStage(text)).toMatch(SUBSET)
  })

  it('refuses a byte-order mark, at the start or inside a value', () => {
    expect(yamlStage('\uFEFFa: 1')).toMatch(SUBSET)
    expect(yamlStage('a: "x\uFEFFy"')).toMatch(SUBSET)
  })

  it('refuses a lone CR but reads CRLF line endings', () => {
    expect(yamlStage('a: 1\rb: 2')).toMatch(SUBSET)
    expect(readAs('a: 1\r\nb: 2')).toEqual({ a: 1, b: 2 })
  })

  it.each([
    ['NUL', '\u0000'],
    ['BEL', '\u0007'],
    ['ESC', '\u001b'],
  ])('refuses a raw %s, even inside double quotes', (_label, char) => {
    expect(yamlStage(`a: "x${char}y"`)).toMatch(SUBSET)
    expect(yamlStage(`a: x${char}y`)).toMatch(SUBSET)
  })

  it.each([
    '\u0000',
    '\u0007',
    '\u0008',
    '\u000b',
    '\u000c',
    '\u000e',
    '\u001f',
  ])('refuses the control character U+%s at both ends of each range', (char) => {
    expect(yamlStage(`a: "x${char}y"`)).toMatch(SUBSET)
  })

  it('reads a C1 control only inside double quotes', () => {
    expect(readAs('a: "x\u0085y"')).toEqual({ a: 'x\u0085y' })
    for (const text of ['a: x\u0085y', "a: 'x\u0085y'", 'a: |\n  x\u0085y', 'a: x\u007fy']) {
      expect(yamlStage(text)).toMatch(SUBSET)
    }
  })

  it.each([
    ['a block mapping', 'a:\n\tb: 1'],
    ['a flow continuation', 'a: [1,\n\t2]'],
    ['a plain continuation', 'a: x\n\ty'],
    ['a quoted continuation', 'a: "x\n\ty"'],
    ['a block scalar', 'a: |\n  x\n\ty'],
    ['spaces then a tab', 'a:\n  b: x\n  \ty'],
  ])('refuses a tab indenting %s', (_label, text) => {
    expect(yamlStage(text)).toMatch(SUBSET)
  })

  it('reads a tab inside a line', () => {
    expect(readAs('a: x\ty\nb:\t1')).toEqual({ a: 'x\ty', b: 1 })
  })

  it.each([
    ['a list key', '? [a, b]\n: 1'],
    ['a mapping key', '? {a: 1}\n: 1'],
    ['a flow list key', '[a, b]: 1'],
    ['a flow mapping key', '{a: 1}: 1'],
    ['a block list key', '? - a\n: 1'],
  ])('refuses %s', (_label, text) => {
    expect(yamlStage(text)).toMatch(SUBSET)
  })

  it('refuses a pair inside a flow list', () => {
    expect(yamlStage('a: [b: 1]')).toMatch(SUBSET)
  })

  it('refuses ? inside a flow mapping', () => {
    expect(yamlStage('a: {? b : 1}')).toMatch(SUBSET)
  })

  it('refuses an empty implicit key', () => {
    expect(yamlStage(': x')).toMatch(SUBSET)
    expect(yamlStage('a:\n  : x')).toMatch(SUBSET)
  })

  it('refuses an explicit key that stringify would not have written', () => {
    expect(yamlStage('? a\n: 1')).toMatch(SUBSET)
    expect(yamlStage(`? ${'k'.repeat(1024)}\n: 1`)).toMatch(SUBSET)
  })

  it.each([
    ['an escaped high surrogate', 'a: "\\uD800"'],
    ['an escaped low surrogate', 'a: "\\uDC00"'],
    ['an escaped reversed pair', 'a: "\\uDE00\\uD83D"'],
    ['a raw lone surrogate in a value', 'a: x\uD800y'],
    ['a raw lone surrogate in a key', 'k\uDC00: 1'],
    ['an escaped lone surrogate in a key', '"k\\uD800": 1'],
    ['a lone surrogate in a block scalar', 'a: |\n  x\uD800'],
  ])('refuses %s', (_label, text) => {
    expect(yamlStage(text)).toMatch(SUBSET)
  })

  it('reads an escaped surrogate pair', () => {
    expect(readAs('a: "\\uD83D\\uDE00"')).toEqual({ a: '\u{1F600}' })
  })

  it('still refuses anchors, aliases and depth', () => {
    expect(yamlStage('a: &x 1')).toMatch(/YAML anchors and aliases are not allowed/)
    expect(yamlStage('a: &x 1\nb: *x')).toMatch(/YAML anchors and aliases are not allowed/)
    expect(yamlStage(`${'a: '.repeat(1)}${'['.repeat(40)}${']'.repeat(40)}`)).toMatch(
      /at most 32 levels/,
    )
  })

  it('reports a refusal through parseOkf as a yaml-stage failure', () => {
    const result = parseOkf('---\ntype: note\nx: !!str 1\n---\nbody')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.stage).toBe('yaml')
    expect(result.error.message).toMatch(/^malformed YAML frontmatter: /)
  })
})

describe('the frontmatter YAML subset: what the reader still reads', () => {
  const long = 'k'.repeat(1025)
  it.each([
    [
      'a block scalar',
      'a: |\n  one\n  two\nb: >-\n  folded\n  text\n',
      { a: 'one\ntwo\n', b: 'folded text' },
    ],
    ['a keep-chomped block scalar with an indent digit', 'a: |2+\n   x\n\n', { a: ' x\n\n' }],
    ['a double-quoted escape', 'a: "x\\ny\\u0001\\x85"', { a: 'x\ny\u0001\u0085' }],
    ['a single-quoted scalar', "a: 'it''s'", { a: "it's" }],
    ['a multi-line plain scalar', 'a: one\n  two\n', { a: 'one two' }],
    ['a folded long double-quoted line', 'a: "one\n  two"', { a: 'one two' }],
    [
      'flow collections',
      'a: [1, {b: c}, [d]]\ne: {f: [g], h}',
      { a: [1, { b: 'c' }, ['d']], e: { f: ['g'], h: null } },
    ],
    ['a comment', '# c\na: 1 # d\n# e', { a: 1 }],
    ['the explicit key stringify writes for a long key', `? ${long}\n: 1`, { [long]: 1 }],
  ])('reads %s', (_label, text, expected) => {
    expect(readAs(text)).toEqual(expected)
  })
})

describe('what serializeOkf writes reads back', () => {
  const long = 'k'.repeat(1025)
  const prose = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  it.each([
    ['a long key written as an explicit key', { [long]: 'v' }],
    ['a long key with a long value', { [long]: prose }],
    ['a long line folded across lines', { a: prose }],
    [
      'a multi-line string as a block scalar',
      { a: 'one\ntwo\n', b: 'x\n\ny', c: '\n\nz', d: ' lead\n  two' },
    ],
    ['a line of only spaces inside a multi-line string', { a: ' \n', b: '\n  \n', c: 'x\n \ny' }],
    [
      'a long multi-line string with a space before a line break',
      { a: `${prose} \n\u0001${prose}`, b: `${prose}\n \n${prose}` },
    ],
    ['a block scalar with a tab on a continuation line', { a: 'x\n\ty', b: 'x\n  \ty' }],
    ['a string with a C1 control or DEL', { a: 'x\u0085y', '\u007f': '\u009f' }],
    ['a string with an escaped C0 control', { a: 'x\u0001y\u001b' }],
    ['a string with a tab inside a line', { 'k\tj': 'x\ty' }],
    ['an empty key and empty string', { '': '' }],
    [
      'strings that would read as another type',
      { a: 'true', b: '1', c: 'null', d: '~', e: '0x10' },
    ],
  ])('%s', (_label, raw) => {
    const result = parseOkf(
      serializeOkf({ frontmatter: { type: 'note', facetsRaw: raw }, body: '' }),
    )
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
    if (result.ok) expect(result.value.frontmatter.facetsRaw).toEqual(raw)
  })
})
