import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { highlightCode } from '../highlight/lowlight.js'

/**
 * The host's tokens for every fence the markdown-document recordings
 * (`layout-markdown.<surface>.jsonl`) can lay out, as `[lang, value, lines]`
 * rows the core's `codeTokens` carries (`null` where the highlighter answers
 * nothing). The core asks its host for a fence's tokens rather than holding a
 * highlighter (owner decision q75), and the native replay
 * (`crates/bindings/wasm/tests/markdown_oracle.rs`) has no host, so it answers
 * from these rows as the shim answers from `highlightCode`.
 *
 * The rows are frozen, with no writer: the TypeScript parser that read the
 * fences off the recorded bodies is gone, and the core is held to these rows
 * and not the other way round.
 */
const FILE = new URL('layout-markdown-fences.jsonl', import.meta.url)

type Row = readonly [string, string, unknown]

describe('the recorded fence tokens of the markdown-document oracle', () => {
  const rows = readFileSync(FILE, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Row)

  it('holds fences the highlighter colours and fences it does not', () => {
    expect(rows.filter((row) => row[2] !== null).length, 'coloured').toBeGreaterThan(2)
    expect(
      rows.some((row) => row[2] === null),
      'plain',
    ).toBe(true)
  })

  it('holds the tokens the highlighter answers today for each fence', () => {
    expect(rows.map(([lang, value]) => highlightCode(lang, value) ?? null)).toEqual(
      rows.map((row) => row[2]),
    )
  })
})
