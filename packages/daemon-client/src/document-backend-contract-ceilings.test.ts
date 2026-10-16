import { describe, expect, it } from 'vitest'
import source from './test-utils/document-backend-contract.ts?raw'

/**
 * The contract's ceilings are named constants because they are raised for one
 * reason — a loaded run measured a delivery past them — and a literal left
 * beside the constant is the one site that raise misses, usually in the
 * slowest case. A wait given no options at all is the same miss in its
 * quietest form: it falls back to the library's own default, which is no
 * ceiling anybody here chose.
 */
describe('document-backend-contract ceilings', () => {
  it('declares every timeout through a named constant, never a numeric literal', () => {
    const literals = source.match(/\btimeout:\s*[\d_]+/g) ?? []

    expect(literals).toEqual([])
  })

  it('finds the timeouts it is guarding', () => {
    // A pattern that stopped matching would otherwise pass the check above over nothing.
    expect(source.match(/\btimeout:\s*[A-Z_]+_MS\b/g)?.length ?? 0).toBeGreaterThan(10)
  })

  it('gives every waitFor a named ceiling', () => {
    const unbounded = waitForCalls(source)
      .filter((call) => !/\btimeout:\s*[A-Z_]+_MS\b/.test(call.text))
      .map((call) => `line ${call.line}: ${call.text.split('\n')[0]}`)

    expect(unbounded).toEqual([])
  })

  it('finds the waitFor calls it is guarding', () => {
    // A scanner that stopped recognising a call would pass the check above over nothing.
    expect(waitForCalls(source).length).toBeGreaterThan(10)
  })
})

/**
 * Every `waitFor(...)` call in `text`, with its whole argument list — matched
 * by paren depth, since an assertion callback spans lines and nests calls of
 * its own.
 */
function waitForCalls(text: string): { line: number; text: string }[] {
  const calls: { line: number; text: string }[] = []
  for (const match of text.matchAll(/\bwaitFor\(/g)) {
    const start = match.index
    let depth = 0
    let end = start + match[0].length - 1
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++
      else if (text[end] === ')' && --depth === 0) break
    }
    calls.push({ line: text.slice(0, start).split('\n').length, text: text.slice(start, end + 1) })
  }
  return calls
}
