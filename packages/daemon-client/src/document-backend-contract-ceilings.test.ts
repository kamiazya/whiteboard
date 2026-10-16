import { describe, expect, it } from 'vitest'

/**
 * Every file the contract is written across: the case families, and the
 * harness whose delivery helpers they all wait through. Globbed, so every
 * `document-backend-*.ts` is read; the first case below pins the exact list,
 * so a family split out later fails it until it is named there — adding a
 * file is a deliberate one-line edit, never a silent one.
 */
const sources = import.meta.glob<string>('./test-utils/document-backend-*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/**
 * The contract's ceilings are named constants because they are raised for one
 * reason — a loaded run measured a delivery past them — and a literal left
 * beside the constant is the one site that raise misses, usually in the
 * slowest case. A wait given no options at all is the same miss in its
 * quietest form: it falls back to the library's own default, which is no
 * ceiling anybody here chose.
 */
describe('document-backend-contract ceilings', () => {
  it('reads the contract, its harness and its stream cases', () => {
    expect(Object.keys(sources).sort()).toEqual([
      './test-utils/document-backend-contract.ts',
      './test-utils/document-backend-harness.ts',
      './test-utils/document-backend-stream-cases.ts',
    ])
  })

  it('declares every timeout through a named constant, never a numeric literal', () => {
    const literals = everyFile((file, source) =>
      (source.match(/\btimeout:\s*[\d_]+/g) ?? []).map((literal) => `${file}: ${literal}`),
    )

    expect(literals).toEqual([])
  })

  it('finds the timeouts it is guarding', () => {
    // A pattern that stopped matching would otherwise pass the check above over nothing.
    const named = everyFile((_, source) => source.match(/\btimeout:\s*[A-Z_]+_MS\b/g) ?? [])
    expect(named.length).toBeGreaterThan(10)
  })

  it('gives every waitFor a named ceiling', () => {
    const unbounded = everyFile((file, source) =>
      waitForCalls(source)
        .filter((call) => !/\btimeout:\s*[A-Z_]+_MS\b/.test(call.text))
        .map((call) => `${file} line ${call.line}: ${call.text.split('\n')[0]}`),
    )

    expect(unbounded).toEqual([])
  })

  it('finds the waitFor calls it is guarding', () => {
    // A scanner that stopped recognising a call would pass the check above over nothing.
    expect(everyFile((_, source) => waitForCalls(source)).length).toBeGreaterThan(10)
    // Per file too: a file the scanner reads as holding no wait at all is one
    // it is not actually reading, however healthy the total looks.
    const silent = Object.entries(sources)
      .filter(([, source]) => waitForCalls(source).length === 0)
      .map(([file]) => file)
    expect(silent).toEqual([])
  })
})

function everyFile<T>(scan: (file: string, source: string) => T[]): T[] {
  return Object.entries(sources).flatMap(([file, source]) => scan(file, source))
}

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
