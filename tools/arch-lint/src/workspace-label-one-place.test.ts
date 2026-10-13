/**
 * What the web app SHOWS for a workspace is `workspaceLabel`'s precedence —
 * display name, else segment, else id — and this scan is its executable half.
 *
 * The rule's failure mode is not two sites disagreeing but one site knowing
 * about fewer layers than there are: `displayName ?? workspaceId` compiles,
 * renders, and shows a raw ULID for a workspace that has a segment and no
 * display name. Every inline copy is a chance to drop the middle layer, so
 * the precedence is written once and everything else calls it.
 *
 * Its floor: a fallback spelled through other names (`name ?? id`) passes.
 * The scan reads the spelling that every copy so far has used, which is the
 * one a new site copies from.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const LABEL_SITE = 'apps/web/src/lib/workspace-handle.ts'

/**
 * Files that still spell the precedence inline, each with why. Checked from
 * both sides: an entry whose file no longer spells it fails too.
 */
const INLINE_LABELS: Readonly<Record<string, string>> = {}

/** `displayName ?? <anything>.segment` or `displayName ?? <anything>.workspaceId`. */
const INLINE_LABEL = /displayName\s*\?\?\s*[\w.?]*\b(?:segment|workspaceId)\b/g

function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

function count(source: string): number {
  return code(source).match(INLINE_LABEL)?.length ?? 0
}

const webFiles = walkSourceFiles(join(REPO_ROOT, 'apps/web/src')).filter(
  (path) => !isExcludedPath(path) && !isTestPath(path),
)

const spellers = webFiles
  .map((path) => relativeToRepo(path))
  .filter((rel) => rel !== LABEL_SITE && count(readFileSync(join(REPO_ROOT, rel), 'utf8')) > 0)

describe('a workspace label is spelled in one place', () => {
  it('recognises the inline precedence and passes neighbours and prose through', () => {
    expect(count('label: entry.displayName ?? entry.segment ?? entry.workspaceId,')).toBe(1)
    expect(count('{target.displayName ?? target.workspaceId}')).toBe(1)
    expect(count('name={displayName ?? workspaceId}')).toBe(1)
    expect(count("const v = active.displayName ?? ''")).toBe(0)
    expect(count('only?.displayName ?? (failed[0] as string)')).toBe(0)
    expect(count(' * `displayName ?? workspaceId` in prose')).toBe(0)
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(webFiles.length).toBeGreaterThan(500)
  })

  it('the declaration site still holds the precedence', () => {
    const source = readFileSync(join(REPO_ROOT, LABEL_SITE), 'utf8')
    expect(source).toContain('export function workspaceLabel(')
    expect(count(source)).toBe(1)
  })

  it('no web file outside workspace-handle spells it unledgered', () => {
    expect(spellers.filter((rel) => !(rel in INLINE_LABELS))).toEqual([])
  })

  it('every ledgered file still spells it', () => {
    expect(Object.keys(INLINE_LABELS).filter((rel) => !spellers.includes(rel))).toEqual([])
  })
})
