import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  commentLinesOf,
  crateDirs,
  measureRustSource,
  rustCode,
  rustCommentLines,
  rustLexemes,
  rustSourceFiles,
} from './rust-source.js'
import { REPO_ROOT } from './scan-roots.js'

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '__fixtures__/rust', name), 'utf8')

const commentTexts = (text: string): string[] =>
  rustLexemes(text).comments.map(([start, end]) => text.slice(start, end))

describe('the Rust lexer the comment and size guards read through', () => {
  const lexing = fixture('lexing.rs')

  it('finds line, doc, inner-doc, trailing and nested block comments', () => {
    expect(commentTexts(lexing)).toEqual([
      "//! The module's own doc comment.",
      '/// A doc comment on an item.',
      '/* An outer block /* with a nested block */ still a comment */',
      '// trailing comment',
    ])
  })

  it('reads no comment inside a string, raw string or byte string', () => {
    const literals = rustLexemes(lexing).literals.map(([start, end]) => lexing.slice(start, end))
    expect(literals).toEqual([
      '"https://a.example/// not a comment"',
      'r#"a "quoted" // word and /* no comment */"#',
      'r##"one "# is not the end"##',
      'b"// bytes, not a comment"',
      "'{'",
      `'"'`,
      "'\\''",
      "'😀'",
      "'}'",
    ])
  })

  it('takes a lifetime, a label and a raw identifier for code, not a literal', () => {
    const code = rustCode(lexing)
    expect(code).toContain("pub fn borrow<'a>(x: &'a str) -> &'a str {")
    expect(code).toContain("'outer: loop {")
    expect(code).toContain('let r#type = ')
  })

  it('keeps every line, so a line number into a projection is one into the source', () => {
    expect(rustCode(lexing).split('\n')).toHaveLength(lexing.split('\n').length)
    const lines = rustCommentLines(lexing)
    expect(lines).toHaveLength(lexing.split('\n').length)
    expect(lines[3]).toBe('')
    expect(lines[15]?.trim()).toBe('// trailing comment')
  })

  it('answers a TypeScript file by its leading comment marker, as the guards always did', () => {
    expect(commentLinesOf('a.ts', 'const a = 1 // tail\n  // head\n * star')).toEqual([
      '',
      '  // head',
      ' * star',
    ])
  })
})

describe('measureRustSource: fn bodies by brace matching over code', () => {
  const measured = measureRustSource(fixture('long-function.rs'), 'f.rs')

  it('measures each fn with a body, qualified by its impl, trait and mod', () => {
    expect(measured.map((row) => row.key)).toEqual([
      'f.rs#Board.tall',
      'f.rs#Board.short',
      'f.rs#Measure.defaulted',
      'f.rs#tests.short',
    ])
  })

  it('counts from the fn line to its closing brace, past braces in literals and comments', () => {
    expect(measured.find((row) => row.key === 'f.rs#Board.tall')?.lines).toBe(52)
    expect(measured.find((row) => row.key === 'f.rs#Board.short')?.lines).toBe(3)
  })

  it('names an impl by its subject under generics nested to any depth', () => {
    const nested = [
      'impl<T> Iterator for Deep<Vec<Option<Box<T>>>> { fn next(&mut self) {} }',
      'impl<F: Fn(u8) -> u8> Apply<F> { fn run(&self) {} }',
      'impl Plain { fn new() {} }',
    ].join('\n')
    expect(measureRustSource(nested, 'h.rs').map((row) => row.key)).toEqual([
      'h.rs#Deep.next',
      'h.rs#Apply.run',
      'h.rs#Plain.new',
    ])
  })

  it('indexes a name that repeats in one scope', () => {
    const twice = 'fn a() {}\n#[cfg(x)]\nfn a() {}\n'
    expect(measureRustSource(twice, 'g.rs').map((row) => row.key)).toEqual(['g.rs#a~1', 'g.rs#a~2'])
  })
})

describe('the Rust tree the guards walk', () => {
  // A walk that found nothing would leave every Rust arm of every guard
  // asserting over an empty set, which reads exactly like a clean tree.
  it('reaches the crates this repo has', () => {
    const files = rustSourceFiles()
    expect(files.length).toBeGreaterThan(10)
    expect(files).toContain('crates/core/det/src/lib.rs')
    expect(files.every((path) => path.startsWith('crates/'))).toBe(true)
    expect(crateDirs()).toContain('crates/xtask')
    expect(crateDirs().length).toBeGreaterThan(4)
  })

  it('lexes every crate file into balanced code', () => {
    for (const path of rustSourceFiles()) {
      const code = rustCode(readFileSync(join(REPO_ROOT, path), 'utf8'))
      const opens = code.split('{').length
      expect([path, opens]).toEqual([path, code.split('}').length])
    }
  })
})
