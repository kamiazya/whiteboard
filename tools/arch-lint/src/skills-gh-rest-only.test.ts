import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

// `gh pr view|checks|list|status|ready|comment|create|merge|edit` and `gh repo
// view` are GraphQL-backed and answer `HTTP 403: GitHub GraphQL is not
// available` in a Claude Code web session — a normal contributor path
// (create, merge and edit measured with gh 2.89: each POSTs to /graphql). A
// skill that tells an agent to run one is an instruction that fails there, and
// a watch loop built on it can read the failure as "nothing pending". Skills
// read and write GitHub over `gh api` (REST); `ci-triage`'s opening paragraph
// carries the read forms, and the PR hooks' reader (hook-command-lib.mjs) the
// create/merge/edit ones.
const GRAPHQL_BACKED =
  /\bgh\s+(?:pr\s+(?:view|checks|list|status|ready|comment|create|merge|edit)|repo\s+view)\b/

// A line that NAMES the form as the broken one is the one place it may appear:
// it says GraphQL, quotes the 403, or points at the REST form that replaces it.
const NAMES_IT_AS_BROKEN = /GraphQL|\b403\b|REST form of/

function offendingLines(): string[] {
  return trackedFiles(REPO_ROOT, '.claude/skills/*.md').flatMap((file) =>
    readFileSync(join(REPO_ROOT, file), 'utf-8')
      .split('\n')
      .flatMap((line, i) =>
        GRAPHQL_BACKED.test(line) && !NAMES_IT_AS_BROKEN.test(line)
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
    ]) {
      expect(GRAPHQL_BACKED.test(form), form).toBe(true)
    }
    for (const form of [
      'gh api repos/{owner}/{repo}/pulls/1',
      'gh api -X PUT repos/{owner}/{repo}/pulls/12/merge -f merge_method=squash',
      'gh stack submit',
      'gh pr mergeable',
    ]) {
      expect(GRAPHQL_BACKED.test(form), form).toBe(false)
    }
  })
})
