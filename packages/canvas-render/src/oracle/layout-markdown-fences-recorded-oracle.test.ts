import { readdirSync, readFileSync } from 'node:fs'
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import { nodeText } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { highlightCode } from '../highlight/lowlight.js'
import type { MarkdownMeta, MarkdownRecord } from '../test-utils/markdown-document-oracle/oracle.js'

/**
 * The host's tokens for every fence the markdown-document recordings
 * (`layout-markdown.<surface>.jsonl`) can lay out, as `[lang, value, lines]`
 * rows the core's `codeTokens` carries (`null` where the highlighter answers
 * nothing). The core asks its host for a fence's tokens rather than holding a
 * highlighter (owner decision q75), and the native replay
 * (`crates/bindings/wasm/tests/markdown_oracle.rs`) has no host, so it answers
 * from these rows as the shim answers from `highlightCode`.
 *
 * The fences are read off the recorded bodies, the referenced bodies and the
 * referenced boards' text nodes, so the table holds every fence the core can
 * ask for and some it never will. Re-record with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node layout-markdown-fences`.
 */
const DIR = new URL('./', import.meta.url)
const FILE = new URL('layout-markdown-fences.jsonl', DIR)
const SURFACE_FILE = /^layout-markdown\.[a-z]+\.jsonl$/

type Row = readonly [string, string, unknown]

function sources(): string[] {
  const texts: string[] = []
  for (const name of readdirSync(DIR)
    .filter((n) => SURFACE_FILE.test(n))
    .sort()) {
    const [head = '', ...lines] = readFileSync(new URL(name, DIR), 'utf8').trimEnd().split('\n')
    const meta = JSON.parse(head) as MarkdownMeta
    for (const [, entry] of meta.references.entries) {
      if (entry?.body !== undefined) texts.push(entry.body)
      for (const node of entry?.canvas?.nodes ?? []) {
        const body = nodeText(node)
        if (body !== undefined) texts.push(body)
      }
    }
    for (const line of lines) texts.push((JSON.parse(line) as MarkdownRecord).body)
  }
  return texts
}

/** Every `code` node under `node`, as `[lang, value]`. */
function fencesOf(node: unknown, into: Map<string, readonly [string, string]>): void {
  if (typeof node !== 'object' || node === null) return
  const { type, lang, value, children } = node as Record<string, unknown>
  if (type === 'code' && typeof lang === 'string' && typeof value === 'string') {
    into.set(JSON.stringify([lang, value]), [lang, value])
  }
  if (Array.isArray(children)) for (const child of children) fencesOf(child, into)
}

function fenceRows(): Row[] {
  const fences = new Map<string, readonly [string, string]>()
  for (const text of sources()) fencesOf(parseMarkdownBody(text), fences)
  return [...fences.values()].map(([lang, value]) => [
    lang,
    value,
    highlightCode(lang, value) ?? null,
  ])
}

const text = (rows: readonly Row[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

describe('the recorded fence tokens of the markdown-document oracle', () => {
  const recorded = readFileSync(FILE, 'utf8')
  const rows = recorded
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

  it('equals the fences the TypeScript parser finds today (deleted with the parser)', () => {
    expect(recorded).toBe(text(fenceRows()))
  })
})
