import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

// A comment is read for as long as the code is, so it carries the rule and
// the reason, not the occasion that produced it. "The dogfood report: on a
// phone, …", "(User decision, this session.)" and "the shape of this session's
// bug report" are each a true sentence about a conversation nobody can open
// any more; the reader three years on needs what they decided, and `git blame`
// already names the commit that decided it. The Source Comment Discipline in
// AGENTS.md says so in prose, and eight comments said otherwise.
//
// Narrow on purpose. "this session" alone is also this app's own word — a
// document-sync session, a daemon session, `this session's doc` — and a scan
// for the bare words read fifty legitimate comments as violations. What stays
// is the shape that only ever named a working session: the dev-workflow's own
// vocabulary (`audit-triage`, a dogfood report, a PR, a review bot), and "this
// session" as the occasion of a decision or a bug report.
//
// The same holds for the markers of WHEN a comment was written: an issue or PR
// number, "this increment", "the next slice", "until 2026-09-19", and a slice
// label such as `S4b` — which two unrelated pieces of work each used for their
// own, and `wave N`, a numbered batch of work. `slice` alone stays free (a
// slice of an array, of the changed files), as does `#130`, React's own
// minified-error number. Name the module or the mechanism instead; `git blame`
// names the change.

const PHRASES: ReadonlyArray<{ readonly pattern: RegExp; readonly name: string }> = [
  { pattern: /\baudit-triage\b/i, name: 'audit-triage' },
  { pattern: /\bdogfood report\b/i, name: 'dogfood report' },
  { pattern: /\bthis PR\b/, name: 'this PR' },
  { pattern: /\bdecision,? this session\b/i, name: 'decision, this session' },
  { pattern: /\bthis session['’]s bug report\b/i, name: "this session's bug report" },
  { pattern: /\bCodeRabbit\b/, name: 'CodeRabbit' },
  { pattern: /\bFound by dogfood/i, name: 'Found by dogfood' },
  { pattern: /(?<![&\w#])#(?!130\b)\d{3,4}\b/, name: 'issue or PR number' },
  {
    pattern: /\b(?:this|the next) (?:increment|slice)\b|\bincrement after this\b/i,
    name: 'this increment / the next slice',
  },
  { pattern: /\b(?:until|since) 20\d\d-\d\d-\d\d\b/, name: 'until/since a date' },
  { pattern: /\b(?:this|same) session measured\b/i, name: 'this session measured' },
  { pattern: /\bS(?:[3-9]|10)[ab]?\b/, name: 'slice label' },
  { pattern: /\bwave \d+\b/i, name: 'wave number' },
]

/**
 * Comments that still carry one, each to be rewritten as the rule it states.
 * The ledger only shrinks: an entry whose comment is gone fails below, so it
 * cannot outlive the fix, and a new hit is never an entry.
 */
const PENDING_REWRITE: ReadonlySet<string> = new Set([])

const SELF = 'tools/arch-lint/src/comment-chronology-phrases.test.ts'

const isComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line)

/** Product code, tests, tools and package-root configs: anywhere a comment is written. */
const isCommentSource = (path: string): boolean =>
  /^(?:packages|apps|tools)\/.+\.(?:tsx?|mjs|mts)$/.test(path) &&
  path !== SELF &&
  !path.includes('/migrations/')

/** The phrases a comment line carries. */
function phrasesIn(line: string): string[] {
  return isComment(line)
    ? PHRASES.filter(({ pattern }) => pattern.test(line)).map(({ name }) => name)
    : []
}

describe('a source comment names the rule, not the working session that produced it', () => {
  it('recognises the occasion phrases and passes the same words used as domain vocabulary', () => {
    expect(phrasesIn('  // The dogfood report: on a phone, a tap did nothing')).toEqual([
      'dogfood report',
    ])
    expect(phrasesIn(' * Extracted from the hook (audit-triage 2026-09-21)')).toEqual([
      'audit-triage',
    ])
    expect(phrasesIn("    // this PR's own migration is exactly such a case")).toEqual(['this PR'])
    expect(phrasesIn('  // what the document WAS. (User decision, this session.)')).toEqual([
      'decision, this session',
    ])
    expect(phrasesIn(" * the list is the shape of this session's bug report,")).toEqual([
      "this session's bug report",
    ])
    expect(phrasesIn('  // Found by CodeRabbit on #1119.')).toEqual([
      'CodeRabbit',
      'issue or PR number',
    ])
    expect(phrasesIn(' * closed by #1767 at the one call site')).toEqual(['issue or PR number'])
    expect(phrasesIn('  // this increment set out to make it possible')).toEqual([
      'this increment / the next slice',
    ])
    expect(phrasesIn('  // Pinned so the next slice has to notice it')).toEqual([
      'this increment / the next slice',
    ])
    expect(phrasesIn('  // Found by dogfooding: the bubble appeared')).toEqual(['Found by dogfood'])
    expect(phrasesIn('  // No Edit row since 2026-09-08: it opened')).toEqual([
      'until/since a date',
    ])
    expect(phrasesIn('  // the same session measured a free event loop')).toEqual([
      'this session measured',
    ])
    expect(phrasesIn('  // the replica-key holder (dual-plane collapse S4b)')).toEqual([
      'slice label',
    ])
    expect(phrasesIn("  // wave 7's deletions were found by hand")).toEqual(['wave number'])
    // Not a comment, and "session" as the app's own noun.
    expect(phrasesIn('  // React throws #130 with no name in it')).toEqual([])
    expect(
      phrasesIn("  // Sonar's S2871 asks for the opposite; a hex colour is #fff or #123456"),
    ).toEqual([])
    expect(
      phrasesIn(
        '  // a slice of the changed files; slice(0, 2); S1 and S2 are the editor invariants',
      ),
    ).toEqual([])
    expect(phrasesIn("const label = 'The dogfood report'")).toEqual([])
    expect(phrasesIn('  // flushes the debounced edit into this session’s own doc')).toEqual([])
    expect(phrasesIn('  // whichever keeper this session runs')).toEqual([])
    expect(phrasesIn('  // a PR-shaped title, not this prefix')).toEqual([])
  })

  it('reads the comment sources worth reading', () => {
    // A scan over an empty list reports clean, which reads as a rule being kept.
    const files = trackedFiles(REPO_ROOT).filter(isCommentSource)
    expect(files.length).toBeGreaterThan(2_000)
    expect(files).toContain('apps/web/vitest.browser.config.ts')
  })

  const found = trackedFiles(REPO_ROOT)
    .filter(isCommentSource)
    .flatMap((file) =>
      readFileSync(join(REPO_ROOT, file), 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          phrasesIn(line).map((name) => ({
            at: `${file}:${index + 1}`,
            key: `${file}#${name}`,
            name,
          })),
        ),
    )

  it('finds no such phrase in a comment outside the ledger', () => {
    const hits = found
      .filter(({ key }) => !PENDING_REWRITE.has(key))
      .map(({ at, name }) => `${at}: "${name}" names the occasion`)
    expect(hits).toEqual([])
  })

  it('holds no ledger entry for a comment that no longer says it', () => {
    const live = new Set(found.map(({ key }) => key))
    expect([...PENDING_REWRITE].filter((key) => !live.has(key))).toEqual([])
  })
})

// A size ledger's ceiling is the reading; the comment above an entry says why
// the file or function is that size. A `968 -> 1053` raise history beside it
// disagreed with the number beneath in 26 places, because each raise appended
// a line and the ceiling was edited without it. A budget constant in a web
// script is the same reading with the same history, so its comments are held
// to the same rule.
const SIZE_LEDGERS: readonly string[] = [
  'tools/arch-lint/src/file-size-budget.test.ts',
  'tools/arch-lint/src/function-size-budget.test.ts',
]

const BUDGET_SCRIPT_ROOTS: readonly string[] = ['apps/web/scripts/']

const LEDGER_ARROW = /\d[\d,]* (?:->|→) \d/

describe('a size ledger comment says why a file is its size, not how it got there', () => {
  it('recognises a raise arrow and passes a bare range', () => {
    expect(LEDGER_ARROW.test('  // Raised 968 -> 1053 for the replica-key route')).toBe(true)
    expect(LEDGER_ARROW.test('  // 3,143 → 3,176: the summary case')).toBe(true)
    expect(LEDGER_ARROW.test('  // the v19 -> v20 upgrade block')).toBe(false)
    expect(LEDGER_ARROW.test('  // ADR-0040 decisions 3-6')).toBe(false)
  })

  it('finds no arrow in either ledger or in a web script', () => {
    const scripts = trackedFiles(REPO_ROOT).filter(
      (file) => BUDGET_SCRIPT_ROOTS.some((root) => file.startsWith(root)) && isCommentSource(file),
    )
    // A guard that reads nothing reports clean.
    expect(scripts).toContain('apps/web/scripts/smoke-bundle-size.mjs')
    expect(scripts.length).toBeGreaterThan(5)
    const hits = [...SIZE_LEDGERS, ...scripts].flatMap((file) => {
      const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')
      expect(lines.length).toBeGreaterThan(SIZE_LEDGERS.includes(file) ? 300 : 0)
      return lines.flatMap((line, index) =>
        isComment(line) && LEDGER_ARROW.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
      )
    })
    expect(hits).toEqual([])
  })
})
