import { describe, expect, it } from 'vitest'
import { highlightCode } from './syntax-highlight.js'

describe('the lowlight side of canvas-render highlightCode seam', () => {
  it('returns one array per SOURCE line, which is what the seam validates on', () => {
    const source = 'const x = 1\n// note\n'
    const lines = highlightCode('ts', source)
    expect(lines).toHaveLength(source.split('\n').length)
  })

  it('maps hljs classes onto the five roles, and leaves the rest plain', () => {
    const lines = highlightCode('ts', 'const x = "hi" // note')
    const tokens = (lines ?? []).flat()
    expect(tokens.map((token) => token.role)).toContain('keyword')
    expect(tokens.map((token) => token.role)).toContain('string')
    expect(tokens.map((token) => token.role)).toContain('comment')
    expect(tokens.some((token) => token.role === undefined)).toBe(true)
  })

  it('never colours punctuation as a keyword — the failure shiki showed on a five-role theme', () => {
    const tokens = (highlightCode('ts', 'const a: number = b ?? c') ?? []).flat()
    for (const token of tokens) {
      if (token.role !== 'keyword') continue
      expect(token.text.trim()).toMatch(/^[A-Za-z]/)
    }
  })

  it('preserves the source text exactly, so the fence still reads as written', () => {
    const source = 'function f() {\n  return  "  spaced  "\n}'
    const joined = (highlightCode('typescript', source) ?? [])
      .map((line) => line.map((token) => token.text).join(''))
      .join('\n')
    expect(joined).toBe(source)
  })

  it('resolves the aliases people actually type in a fence', () => {
    for (const alias of ['ts', 'tsx', 'js', 'sh', 'py', 'yml', 'html']) {
      expect(highlightCode(alias, 'x')).toBeDefined()
    }
  })

  it('degrades to plain for an unregistered language, and for no language', () => {
    expect(highlightCode('brainfuck', '+++')).toBeUndefined()
    expect(highlightCode('', 'plain text')).toBeUndefined()
  })
})
