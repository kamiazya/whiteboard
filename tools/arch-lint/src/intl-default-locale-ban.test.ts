/**
 * The shared layer answers the same on every machine: what it splits or folds
 * must not depend on the runtime's DEFAULT locale. An `Intl` service built
 * with `undefined` (or nothing) reads whatever the host is configured with,
 * so one document can cut or match differently on two machines — and a
 * reimplementation of the same code has nothing to reproduce. Construct it
 * with an explicit locale (`'en'`), as `emoji/searchable.ts` always did; the
 * Unicode version itself is the runtime's, pinned by `.node-version`
 * (QR-20b). `localeCompare` is the same defect in a sort, and has its own
 * scan, `locale-compare-ban.test.ts`, with a ledger for display orders.
 *
 * Comment lines are skipped, so prose that names the banned spelling — a
 * mutant a file's comment describes, say — does not count.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHARED_LAYER_PACKAGES } from './scan-packages.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const LOCALE_DEFAULTING: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: 'Intl service under the default locale',
    pattern:
      /\bIntl\.(?:Segmenter|Collator|DateTimeFormat|NumberFormat|PluralRules)\(\s*(?:undefined\b|\))/,
  },
  { name: 'toLocale*Case() without a locale', pattern: /\.toLocale(?:Lower|Upper)Case\(\s*\)/ },
]

const files = SHARED_LAYER_PACKAGES.flatMap((pkg) => walkSourceFiles(join(REPO_ROOT, pkg, 'src')))
  .map((path) => relative(REPO_ROOT, path))
  .filter((path) => !isTestPath(path))

describe('the shared layer builds no Intl service under the default locale', () => {
  it('scans the shared layer', () => {
    // An empty walk agrees with every assertion below.
    expect(files.length).toBeGreaterThan(400)
  })

  it('names a locale wherever production source constructs one', () => {
    // The whole file at once, not a line at a time: the formatter breaks a
    // long constructor call after `(`, which puts `undefined` on the next
    // line and out of a per-line pattern's sight. Comments and strings are
    // stripped first, so a sentence about the ban cannot trip it.
    const hits = files.flatMap((path) => {
      const source = stripCommentsAndStrings(readFileSync(join(REPO_ROOT, path), 'utf8'), path)
      return LOCALE_DEFAULTING.flatMap(({ name, pattern }) => {
        const at = pattern.exec(source)
        if (at === null) return []
        const line = source.slice(0, at.index).split('\n').length
        return [`${path}:${line} ${name}`]
      })
    })
    expect(hits).toEqual([])
  })

  it('recognises each shape it bans', () => {
    // Each pattern on the spelling it exists for, so a typo in one cannot
    // leave it matching nothing.
    const samples = [
      "new Intl.Segmenter(undefined, { granularity: 'grapheme' })",
      "new Intl.Segmenter(\n  undefined,\n  { granularity: 'grapheme' },\n)",
      'new Intl.Collator()',
      's.toLocaleLowerCase()',
    ]
    for (const sample of samples) {
      expect(LOCALE_DEFAULTING.some(({ pattern }) => pattern.test(sample))).toBe(true)
    }
    expect(
      LOCALE_DEFAULTING.some(({ pattern }) => pattern.test("new Intl.Segmenter('en', {})")),
    ).toBe(false)
  })
})
