/**
 * An agent definition under `.claude/agents/` is a prompt a subagent obeys
 * literally, so a stale claim there is not merely wrong — it is followed.
 * `docs-retired-claims.test.ts` holds `docs/`; this holds the agent prompts,
 * with the same two-sided shape: each pattern must still match its own
 * `example`, so an entry cannot go inert and read as a clean tree.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const AGENTS_DIR = join(REPO_ROOT, '.claude/agents')

const agents = readdirSync(AGENTS_DIR)
  .filter((name) => name.endsWith('.md'))
  .map((name) => ({ name, text: readFileSync(join(AGENTS_DIR, name), 'utf-8') }))

const RETIRED = [
  {
    pattern: /\blacks?\s+`?node_modules/i,
    why: '`new-worktree.mjs` installs a worktree’s own node_modules; an agent told otherwise runs its tests from the main tree, where a relative path runs the main tree’s copy of the file',
    example: 'Note: worktrees lack `node_modules`, so prefer running tests on the main tree',
  },
] as const

describe('agent prompts carry no retired claim', () => {
  it('reads the agent definitions', () => {
    expect(agents.length).toBeGreaterThan(10)
    expect(agents.map(({ name }) => name)).toContain('developer.md')
  })

  it.each(RETIRED)('still matches its own example: $why', ({ pattern, example }) => {
    expect(pattern.test(example)).toBe(true)
  })

  it.each(RETIRED)('is absent from every agent prompt: $pattern', ({ pattern, why }) => {
    expect(
      agents.filter(({ text }) => pattern.test(text)).map(({ name }) => name),
      why,
    ).toEqual([])
  })
})
