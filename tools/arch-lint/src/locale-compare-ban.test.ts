/**
 * `localeCompare` is not called in shipped package source, outside a ledger of
 * display orders.
 *
 * Why it needs a scan. `localeCompare` reads the host's default locale and ICU
 * data, so an order built on it — a limit cut, a digest input, a tie-break, a
 * canonical pair — differs between two machines holding identical input, and
 * it folds case and punctuation, so it also disagrees with the code-unit order
 * the ports' `compareDocumentPaths` gives `listDocuments`. `compareCodeUnit`
 * (`model`) is the one deterministic spelling, and a static analyser nudges
 * every reader toward the other, so only a rule about where the call may
 * appear holds.
 *
 * The ledger is for a sort of text a PERSON reads in a list, where the
 * reader's own alphabet is the point. Each entry says why the order may vary
 * by host, and is guarded from both sides: a count that no longer matches
 * fails, so an entry cannot outlive the call it excuses.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'
import { REPO_ROOT } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

const BANNED = ['localeCompare'] as const

interface LedgerEntry {
  readonly uses: number
  readonly why: string
}

const LEDGER: Readonly<Record<string, LedgerEntry>> = {
  'packages/plugin-visual/src/icons/shortcode.ts': {
    uses: 1,
    why: 'orders the completion list of built-in icon names a person scrolls, never persisted or digested',
  },
}

const REASON = /^(\S+\s+){7,}\S+/

function shippedPackageSource(): readonly string[] {
  return walkSourceFiles(join(REPO_ROOT, 'packages'))
    .map((absolute) => relative(REPO_ROOT, absolute).split(sep).join('/'))
    .filter((path) => /^packages\/[^/]+\/src\//.test(path) && isShippedPath(path))
}

function usesIn(path: string): number {
  return countNamedUses(path, readFileSync(join(REPO_ROOT, path), 'utf8'), BANNED)
}

const files = shippedPackageSource()
const used = new Map(
  files.map((path): [string, number] => [path, usesIn(path)]).filter(([, count]) => count !== 0),
)

describe('localeCompare is banned in shipped package source', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(files.length).toBeGreaterThan(500)
  })

  it('every use is a ledgered display order', () => {
    const unledgered = [...used.keys()].filter((path) => LEDGER[path] === undefined)
    expect(
      unledgered,
      'use `compareCodeUnit` from @kamiazya/whiteboard-model (or `compareDocumentPaths` for paths): `localeCompare` reorders with the host locale and ICU data',
    ).toEqual([])
  })

  it('every ledger entry still names exactly the uses it excuses', () => {
    const drifted = Object.entries(LEDGER)
      .filter(([path, entry]) => (used.get(path) ?? 0) !== entry.uses)
      .map(([path]) => path)
    expect(drifted, 'an entry that outlives its call is how a ledger stops being read').toEqual([])
  })

  it('every ledger entry gives a reason of at least eight words', () => {
    const bare = Object.entries(LEDGER)
      .filter(([, entry]) => !REASON.test(entry.why))
      .map(([path]) => path)
    expect(bare).toEqual([])
  })

  describe('the scan itself, on planted source', () => {
    it('sees a direct call, a bracket access and an aliased binding', () => {
      const planted = [
        'export const direct = (a: string, b: string) => a.localeCompare(b)',
        "export const bracket = (a: string, b: string) => a['localeCompare'](b)",
        'const { localeCompare: collate } = String.prototype',
        'export const aliased = collate',
      ].join('\n')
      expect(countNamedUses('planted.ts', planted, BANNED)).toBeGreaterThanOrEqual(3)
    })

    it('is not moved by a comment or a string that merely names it', () => {
      const planted = [
        '// `localeCompare` reads the host locale',
        "export const note = 'localeCompare is banned'",
        'export const order = (a: string, b: string) => (a < b ? -1 : 1)',
      ].join('\n')
      expect(countNamedUses('planted.ts', planted, BANNED)).toBe(0)
    })
  })
})
