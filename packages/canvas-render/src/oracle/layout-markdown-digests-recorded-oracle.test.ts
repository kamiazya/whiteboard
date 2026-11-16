import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MarkdownRecord } from '../test-utils/markdown-document-oracle/oracle.js'

/**
 * The scenes the markdown-document recordings hold as a digest
 * (`layout-markdown.<surface>.jsonl` records with `n` and `h`), digested
 * again over their text with every object's keys sorted: one `{id, n, h}`
 * row per such record, in file order. A recorded digest is taken over the
 * TypeScript's own key order, which follows the order each object was built
 * in and differs between two objects of one kind, so the core's answer can
 * be held to the scene's values but never to that order; these rows are what
 * the native replay (`crates/bindings/wasm/tests/markdown_oracle.rs`) and
 * canvas-render-rust's replay hold a long scene to. Taken from the TypeScript
 * before it was deleted (ADR-0054 step 7, S18h) and frozen with the recordings
 * it digests.
 */
const DIR = new URL('./', import.meta.url)
const FILE = new URL('layout-markdown-digests.jsonl', DIR)
const SURFACE_FILE = /^layout-markdown\.[a-z]+\.jsonl$/

/** The id of every digest record of every surface file, in file order. */
function digestIds(): string[] {
  return readdirSync(DIR)
    .filter((n) => SURFACE_FILE.test(n))
    .sort()
    .flatMap((name) =>
      readFileSync(new URL(name, DIR), 'utf8')
        .trimEnd()
        .split('\n')
        .slice(1)
        .map((line) => JSON.parse(line) as MarkdownRecord)
        .filter((record) => 'n' in record)
        .map((record) => record.id),
    )
}

describe('the sorted-key digests of the markdown-document oracle', () => {
  const rows = readFileSync(FILE, 'utf8').trimEnd().split('\n')

  it('holds a row for every digest record of every surface, in file order', () => {
    expect(rows.length).toBeGreaterThan(100)
    expect(rows.every((row) => /"n":\d+,"h":\d+\}$/.test(row))).toBe(true)
    expect(rows.map((row) => (JSON.parse(row) as { id: string }).id)).toEqual(digestIds())
  })
})
