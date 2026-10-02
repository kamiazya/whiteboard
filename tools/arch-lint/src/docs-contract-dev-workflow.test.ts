import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

// The dev workflow's own instructions (skills, hook remedies, workflow briefs,
// contributor docs) are read by a session at the moment it acts on them, and a
// command that does not work there costs more than a wrong comment: the reader
// follows it, it fails or does nothing, and the failure looks like the repo's.
// Each check below pins one instruction that was found not to work.

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf-8')

// `gh pr view|checks|list|status` and `gh repo view` are GraphQL-backed, and a
// Claude Code web session answers every one with HTTP 403 — a normal
// contributor path, not an edge. The watch loop that treated that failure as
// an empty answer reported a clean PR. So the files that tell an agent how to
// WATCH or TRIAGE a PR read GitHub over REST (`gh api`), and may name the
// GraphQL forms only to forbid them.
const REST_ONLY_FILES = [
  '.claude/skills/ci-triage/SKILL.md',
  '.claude/workflows/ci-triage.workflow.mjs',
  '.claude/workflows/pr-feedback.workflow.mjs',
  '.claude/workflows/dependabot-triage.workflow.mjs',
]
const GRAPHQL_GH = /\bgh\s+(?:pr\s+(?:view|checks|list|status)|repo\s+view)\b/
const FORBIDS_IT = /GraphQL|\b403\b|\bnever\b|\bREST\b/

describe('PR watch and triage instructions read GitHub over REST', () => {
  it.each(REST_ONLY_FILES)('%s names no GraphQL-backed gh call as something to run', (file) => {
    const lines = read(file).split('\n')
    expect(lines.length, `${file} read as empty`).toBeGreaterThan(10)
    const offending = lines
      .map((text, index) => ({ text, line: index + 1 }))
      .filter(({ text }) => GRAPHQL_GH.test(text) && !FORBIDS_IT.test(text))
    expect(
      offending,
      `${file} tells an agent to run a GraphQL-backed gh command; use \`gh api repos/{owner}/{repo}/…\``,
    ).toEqual([])
  })

  it('the ci-triage watch loops never turn a failed read into an empty one', () => {
    const loops = [
      ...read('.claude/skills/ci-triage/SKILL.md').matchAll(/```bash\n(PR=<PR>[\s\S]*?)```/g),
    ]
    expect(loops.length, 'the two watch loops were not found').toBe(2)
    for (const [, loop] of loops) expect(loop).not.toMatch(/\|\|\s*echo\s+'\[\]'/)
  })
})
