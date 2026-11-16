import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  inputOf,
  type MarkdownMeta,
  type MarkdownRecord,
  sortedDigest,
} from '../test-utils/markdown-document-oracle/oracle.js'

/**
 * The scenes the markdown-document recordings hold as a digest
 * (`layout-markdown.<surface>.jsonl` records with `n` and `h`), digested
 * again over their text with every object's keys sorted: one `{id, n, h}`
 * row per such record, in file order. A recorded digest is taken over the
 * TypeScript's own key order, which follows the order each object was built
 * in and differs between two objects of one kind, so the core's answer can
 * be held to the scene's values but never to that order; these rows are what
 * the native replay (`crates/bindings/wasm/tests/markdown_oracle.rs`) and
 * canvas-render-rust's replay hold a long scene to. Re-record with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node layout-markdown-digests`.
 */
const DIR = new URL('./', import.meta.url)
const FILE = new URL('layout-markdown-digests.jsonl', DIR)
const SURFACE_FILE = /^layout-markdown\.[a-z]+\.jsonl$/

function digestRows(): string[] {
  const rows: string[] = []
  for (const name of readdirSync(DIR)
    .filter((n) => SURFACE_FILE.test(n))
    .sort()) {
    const [head = '', ...lines] = readFileSync(new URL(name, DIR), 'utf8').trimEnd().split('\n')
    const meta = JSON.parse(head) as MarkdownMeta
    for (const line of lines) {
      const record = JSON.parse(line) as MarkdownRecord
      if (!('n' in record)) continue
      rows.push(JSON.stringify({ id: record.id, ...sortedDigest(inputOf(record), meta) }))
    }
  }
  return rows
}

describe('the sorted-key digests of the markdown-document oracle', () => {
  const fresh = digestRows()
  if (process.env.WHITEBOARD_RECORD_ORACLE === '1') writeFileSync(FILE, `${fresh.join('\n')}\n`)

  it('holds a row for every digest record of every surface', () => {
    expect(fresh.length).toBeGreaterThan(100)
    expect(fresh.every((row) => /"n":\d+,"h":\d+\}$/.test(row))).toBe(true)
  })

  it('equals what the TypeScript answers today', { timeout: 120_000 }, () => {
    expect(readFileSync(FILE, 'utf8')).toBe(`${fresh.join('\n')}\n`)
  })
})
