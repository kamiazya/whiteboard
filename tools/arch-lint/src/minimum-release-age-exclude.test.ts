// `minimumReleaseAgeExclude` is a temporary hole in the 7-day supply-chain
// window, and nothing but a comment used to say when it closes. Entries
// outlived their own "prune on or after" dates and undated ones had no date
// to outlive, so the hole stayed open and its reason decayed.
//
// Every entry therefore sits under a comment carrying
// `prune on or after YYYY-MM-DD`, and this fails once that day arrives. The
// failure is the point: the fix is to delete the entry (the locked version has
// aged past the window by then) or to renew the date with a reason.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const ROOT = REPO_ROOT

const PRUNE_DATE = /prune on or after (\d{4}-\d{2}-\d{2})/

interface ExcludeEntry {
  readonly name: string
  /** The date the nearest comment run above the entry names, if any. */
  readonly pruneOn: string | undefined
}

/**
 * Entries of the `minimumReleaseAgeExclude` block with the prune date from the
 * comment run directly above them. One comment run covers the consecutive
 * entries that follow it, so a pair excluded for one reason carries one date.
 */
function excludeEntries(workspaceYaml: string): ExcludeEntry[] {
  const lines = workspaceYaml.split('\n')
  const start = lines.findIndex((line) => /^minimumReleaseAgeExclude:/.test(line))
  if (start === -1) return []
  const entries: ExcludeEntry[] = []
  let pruneOn: string | undefined
  let lastWasEntry = false
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      if (lastWasEntry) pruneOn = undefined
      lastWasEntry = false
      pruneOn = PRUNE_DATE.exec(line)?.[1] ?? pruneOn
      continue
    }
    if (!line.startsWith('- ')) break
    lastWasEntry = true
    entries.push({ name: line.slice(2).replace(/^["']|["']$/g, ''), pruneOn })
  }
  return entries
}

/** Entries that should be gone, or that never said when. Empty means healthy. */
function expiredOrUndated(workspaceYaml: string, today: string): string[] {
  return excludeEntries(workspaceYaml).flatMap(({ name, pruneOn }) => {
    if (pruneOn === undefined)
      return [`${name}: no "prune on or after YYYY-MM-DD" comment above it`]
    if (pruneOn <= today) return [`${name}: prune on or after ${pruneOn}, which has arrived`]
    return []
  })
}

describe('minimumReleaseAgeExclude carries its own expiry', () => {
  it('has no entry that is undated or past its prune date', () => {
    const yaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf-8')
    const today = new Date().toISOString().slice(0, 10)
    expect(expiredOrUndated(yaml, today)).toEqual([])
  })

  describe('the reader', () => {
    const yaml = [
      'minimumReleaseAge: 10080',
      'minimumReleaseAgeExclude:',
      '  # prune on or after 2026-09-11',
      '  - vitest',
      '  - "@vitest/*"',
      '  # a security patch; prune on or after 2026-12-01',
      '  - qs',
      '  - undated',
      'minimumReleaseAgeStrict: true',
      '  - not-an-entry',
    ].join('\n')

    it('finds every entry in the block and stops at the next key', () => {
      expect(excludeEntries(yaml).map((e) => e.name)).toEqual([
        'vitest',
        '@vitest/*',
        'qs',
        'undated',
      ])
    })

    it('lets one comment run cover the consecutive entries after it', () => {
      expect(excludeEntries(yaml).map((e) => e.pruneOn)).toEqual([
        '2026-09-11',
        '2026-09-11',
        '2026-12-01',
        '2026-12-01',
      ])
    })

    it('drops the previous date when a new comment run starts', () => {
      const split = [
        'minimumReleaseAgeExclude:',
        '  # prune on or after 2026-12-01',
        '  - a',
        '  # no date here',
        '  - b',
      ].join('\n')
      expect(excludeEntries(split).map((e) => e.pruneOn)).toEqual(['2026-12-01', undefined])
    })

    it('reports an entry whose date has arrived and one that never had a date', () => {
      const failures = expiredOrUndated(yaml, '2026-10-01')
      expect(failures).toHaveLength(2)
      expect(failures[0]).toContain('vitest')
      expect(failures[1]).toContain('@vitest/*')
    })

    it('treats an absent or empty block as healthy', () => {
      expect(expiredOrUndated('minimumReleaseAge: 10080\n', '2026-10-01')).toEqual([])
      expect(expiredOrUndated('minimumReleaseAgeExclude: []\n', '2026-10-01')).toEqual([])
    })
  })
})
