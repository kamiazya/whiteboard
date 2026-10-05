import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isShippedPath } from './source-scan.js'
import { commentRanges } from './strip-comments.js'
import { trackedFiles } from './tracked-files.js'

// Two `/** */` blocks with nothing but whitespace between them document ONE
// declaration, and TypeScript shows only the last. The first is read by
// nobody's hover: it is a contract that reaches no reader, and it usually sits
// there because a helper was extracted between an API and its doc, so the
// helper wears the API's description and the API wears none.
//
// Excluded by shape, never by entry: a file's header (the first comment,
// before any code), which documents the module rather than what follows it,
// and a block carrying `@typedef`, `@module` or `@packageDocumentation`, which
// documents something other than the next declaration by definition. Prose
// that heads a SECTION of a file is a `//` comment, because it describes no
// declaration either.

const SELF_DESCRIBING_TAG = /@(?:typedef|module|packageDocumentation)\b/

/** `/**` opens a doc block; `/**\/` is an empty ordinary comment. */
const isDocBlock = (text: string): boolean => /^\/\*\*(?!\/)/.test(text)

/** Whether only a shebang and whitespace come before `offset`. */
const isFileHead = (raw: string, offset: number): boolean =>
  raw.slice(0, offset).replace(/^#!.*/, '').trim() === ''

/** The 1-based line of each doc block that another doc block directly follows. */
function strandedDocBlocks(raw: string, fileName: string): number[] {
  const docs = commentRanges(raw, fileName)
  const lines: number[] = []
  for (let i = 0; i + 1 < docs.length; i++) {
    const [start, end] = docs[i] as [number, number]
    const [nextStart, nextEnd] = docs[i + 1] as [number, number]
    const text = raw.slice(start, end)
    if (!isDocBlock(text) || !isDocBlock(raw.slice(nextStart, nextEnd))) continue
    if (raw.slice(end, nextStart).trim() !== '') continue
    if ((i === 0 && isFileHead(raw, start)) || SELF_DESCRIBING_TAG.test(text)) continue
    lines.push(raw.slice(0, start).split('\n').length)
  }
  return lines
}

/**
 * Stacked blocks kept on purpose, each with its reason. Shrink-only: an entry
 * whose block is gone fails below, and a new site is fixed, never entered.
 */
const STACKED_ON_PURPOSE: Readonly<Record<string, string>> = {}

/** Production source of every package and app: what a hover in an editor reads. */
const isScanned = (path: string): boolean =>
  /^(?:packages|apps)\/[^/]+\/src\/.+\.(?:tsx?|mts)$/.test(path) && isShippedPath(path)

describe('a doc block is the only doc block above its declaration', () => {
  it('flags a block another block follows, and passes headers, tags and separated blocks', () => {
    const stacked = 'const a = 1\n/** The API. */\n\n/** The helper. */\nfunction helper() {}\n'
    expect(strandedDocBlocks(stacked, 'a.ts')).toEqual([2])
    const inMembers = 'interface P {\n  /** gone */\n  /** kept */\n  readonly x: number\n}\n'
    expect(strandedDocBlocks(inMembers, 'a.ts')).toEqual([2])
    const inJsx = 'const v = (\n  <div>\n    {/** a */}\n  </div>\n)\n/** b */ /** c */ let z\n'
    expect(strandedDocBlocks(inJsx, 'a.tsx')).toEqual([6])

    expect(
      strandedDocBlocks('/** Header. */\n\n/** Doc. */\nexport const a = 1\n', 'a.ts'),
    ).toEqual([])
    expect(
      strandedDocBlocks('#!/usr/bin/env node\n/** Header. */\n/** Doc. */\nlet a\n', 'a.ts'),
    ).toEqual([])
    expect(
      strandedDocBlocks('let a\n/** @typedef {number} N */\n/** Doc. */\nlet b\n', 'a.ts'),
    ).toEqual([])
    expect(strandedDocBlocks('let a\n/** A. */\n// section\n/** B. */\nlet b\n', 'a.ts')).toEqual(
      [],
    )
    expect(strandedDocBlocks('let a\n/** A. */\nlet b\n/** B. */\nlet c\n', 'a.ts')).toEqual([])
    expect(strandedDocBlocks('let a\n/**/\n/** B. */\nlet b\n', 'a.ts')).toEqual([])
    // A `/**` inside a string or template is not a comment at all.
    expect(strandedDocBlocks("let a = '/** x */'\n/** B. */\nlet b\n", 'a.ts')).toEqual([])
  })

  const files = trackedFiles(REPO_ROOT).filter(isScanned)

  it('reads the production source of every package and app', () => {
    // A scan over an empty list reports clean, which reads as a rule being kept.
    expect(files.length).toBeGreaterThan(1_200)
    expect(files).toContain('apps/web/src/lib/browser-backend.ts')
    expect(files).toContain('packages/canvas-render/src/layout/edges/grid-route.ts')
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false)
  })

  const found = files.flatMap((file) => {
    const raw = readFileSync(join(REPO_ROOT, file), 'utf8')
    return strandedDocBlocks(raw, file).map((line) => {
      const firstLine = raw.split('\n')[line - 1]?.trim() ?? ''
      return { at: `${file}:${line}`, key: `${file}#${firstLine}` }
    })
  })

  it('finds no doc block stranded above another outside the ledger', () => {
    const hits = found
      .filter(({ key }) => !(key in STACKED_ON_PURPOSE))
      .map(({ at }) => `${at}: this block is followed by another, so it documents nothing`)
    expect(hits).toEqual([])
  })

  it('holds no ledger entry for a block that is no longer stacked', () => {
    const live = new Set(found.map(({ key }) => key))
    expect(Object.keys(STACKED_ON_PURPOSE).filter((key) => !live.has(key))).toEqual([])
  })
})
