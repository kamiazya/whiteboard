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
// vocabulary (`audit-triage`, a dogfood report, a PR), and "this session" as
// the occasion of a decision or a bug report.

const PHRASES: ReadonlyArray<{ readonly pattern: RegExp; readonly name: string }> = [
  { pattern: /\baudit-triage\b/i, name: 'audit-triage' },
  { pattern: /\bdogfood report\b/i, name: 'dogfood report' },
  { pattern: /\bthis PR\b/, name: 'this PR' },
  { pattern: /\bdecision,? this session\b/i, name: 'decision, this session' },
  { pattern: /\bthis session['’]s bug report\b/i, name: "this session's bug report" },
]

/**
 * Comments that still carry one, each to be rewritten as the rule it states.
 * The ledger only shrinks: an entry whose comment is gone fails below, so it
 * cannot outlive the fix, and a new hit is never an entry.
 */
const PENDING_REWRITE: ReadonlySet<string> = new Set([
  'packages/mcp-server/src/server/security/macaroon-root-key.test.ts#this PR',
  'packages/mcp-server/src/server/store/db/index.test.ts#this PR',
  'packages/mcp-server/src/server/store/db/location.test.ts#this PR',
])

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
    // Not a comment, and "session" as the app's own noun.
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
