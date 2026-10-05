import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

// The `gh pr`, `gh issue`, `gh release` and `gh repo` subcommands are
// GraphQL-backed almost without exception, and answer `HTTP 403: GitHub GraphQL
// is not available` in a Claude Code web session — a normal contributor path
// (view, checks, list, status, ready, comment, create, merge, edit, close,
// reopen, review and lock measured on `gh pr`; `gh issue list`, `gh release
// list` and `gh repo view` likewise). A skill that tells an agent to run one is
// an instruction that fails there, and a watch loop built on it can read the
// failure as "nothing pending". Skills read and write GitHub over `gh api`
// (REST); `ci-triage`'s opening paragraph carries the read forms, and the PR
// hooks' reader (hook-command-lib.mjs) the create/merge/edit ones.
//
// So the four nouns are refused unless the subcommand is MEASURED to work over
// REST. A list of the broken ones was the first shape, and it let `gh pr close`
// through because nobody had listed it yet: a new subcommand is unknown, and
// unknown is refused. `gh run …`, `gh api` and `gh stack` are other nouns and
// are not judged. An entry records a measurement rather than a debt, so it is
// not required to have a caller.
const KNOWN_REST: Readonly<Record<string, string>> = {
  'pr diff': 'measured: served by the REST diff media type, works in a web session',
}

const GH_NOUN_SUBCOMMAND = /\bgh\s+(pr|issue|release|repo)\s+([a-z][a-z-]*)/g

function refusedForms(line: string): string[] {
  return [...line.matchAll(GH_NOUN_SUBCOMMAND)]
    .map((m) => `${m[1]} ${m[2]}`)
    .filter((form) => !(form in KNOWN_REST))
}

// A line that NAMES the form as the broken one is the one place it may appear:
// it says GraphQL, quotes the 403, or points at the REST form that replaces it.
const NAMES_IT_AS_BROKEN = /GraphQL|\b403\b|REST form of/

function offendingLines(): string[] {
  return trackedFiles(REPO_ROOT, '.claude/skills/*.md').flatMap((file) =>
    readFileSync(join(REPO_ROOT, file), 'utf-8')
      .split('\n')
      .flatMap((line, i) =>
        refusedForms(line).length > 0 && !NAMES_IT_AS_BROKEN.test(line)
          ? [`${file}:${i + 1}: ${line.trim()}`]
          : [],
      ),
  )
}

describe('skills read GitHub over REST', () => {
  it('no skill instructs a GraphQL-backed gh subcommand', () => {
    expect(
      offendingLines(),
      'these skills tell an agent to run a gh subcommand that answers HTTP 403 in a web session — use `gh api repos/{owner}/{repo}/...` (ci-triage/SKILL.md)',
    ).toEqual([])
  })

  it('reaches the skills it guards, and the pattern recognises the forms', () => {
    expect(trackedFiles(REPO_ROOT, '.claude/skills/*.md').length).toBeGreaterThan(20)
    for (const form of [
      'gh pr view 12',
      'gh  pr   checks <n>',
      'gh pr list',
      'gh pr status',
      'gh pr ready <PR>',
      'gh pr comment <n> --body x',
      'gh repo view',
      'gh pr create --title x --body-file b.md',
      'gh pr merge 12 --squash',
      'gh pr edit 12 --title x',
      'gh pr close 12 --comment "Superseded by #13"',
      'gh pr reopen 12',
      'gh issue create --title x',
      'gh release list',
      'gh pr checkout 12',
    ]) {
      expect(refusedForms(form), form).not.toEqual([])
    }
    for (const form of [
      'gh api repos/{owner}/{repo}/pulls/1',
      'gh api -X PUT repos/{owner}/{repo}/pulls/12/merge -f merge_method=squash',
      'gh api -X PATCH repos/{owner}/{repo}/pulls/12 -f state=closed',
      'gh stack submit',
      'gh run view 123 --log-failed',
      'gh pr diff 12',
    ]) {
      expect(refusedForms(form), form).toEqual([])
    }
  })
})
