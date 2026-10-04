import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

/**
 * What of `.claude/` Biome does not read, and why. `biome.json` is parsed as
 * strict JSON by sibling guards, so it cannot carry these reasons itself; they
 * live here, and the set is held from both sides: a negation under `.claude/`
 * missing from this ledger fails, and so does a ledger entry biome.json no
 * longer negates.
 *
 * Everything else under `.claude/` that Biome parses (`scripts/**`,
 * `workflows/lib/**`, `settings.json`, a skill's JSON) is linted and formatted
 * like the rest of the repo. A blanket `!.claude/**` would hide all of it —
 * thousands of lines of tooling that CI and pre-push run on every change.
 */
const EXCLUDED: Record<string, { reason: string; tracked: boolean }> = {
  '.claude/workflows/*.workflow.mjs': {
    reason:
      'the workflow runtime wraps each script in a function body, so they end in a top-level `return` that Biome cannot parse',
    tracked: true,
  },
  '.claude/scripts/fixtures/**': {
    reason:
      'deliberately bad source: biome-plugin.test.mjs lints these on purpose to prove each GritQL rule still fires',
    tracked: true,
  },
  '.claude/settings.local.json': {
    reason: 'per-machine and gitignored; whatever a developer keeps there is not the repo’s',
    tracked: false,
  },
  '.claude/worktrees/**': {
    reason: 'gitignored whole checkouts of other branches, which would be linted as a second copy',
    tracked: false,
  },
}

function negatedClaudeGlobs(): string[] {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'biome.json'), 'utf8')) as {
    files: { includes: string[] }
  }
  return config.files.includes
    .filter((glob) => glob.startsWith('!.claude/'))
    .map((glob) => glob.slice(1))
}

function trackedMatching(glob: string): string[] {
  return execFileSync('git', ['ls-files', '--', `:(glob)${glob}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line !== '')
}

describe('which of .claude/ biome.json keeps out of the lint run', () => {
  it('names exactly the ledgered paths', () => {
    expect(negatedClaudeGlobs().sort()).toEqual(Object.keys(EXCLUDED).sort())
  })

  it('gives every exclusion a reason', () => {
    for (const [glob, { reason }] of Object.entries(EXCLUDED)) {
      expect(reason.length, glob).toBeGreaterThan(20)
    }
  })

  it('excludes only paths that still hold a file', () => {
    for (const [glob, { tracked }] of Object.entries(EXCLUDED)) {
      if (tracked) expect(trackedMatching(glob).length, glob).toBeGreaterThan(0)
    }
  })

  it('still finds a top-level return in a workflow, the reason those stay out', () => {
    const workflows = trackedMatching('.claude/workflows/*.workflow.mjs')
    const withReturn = workflows.filter((file) =>
      /^return\b/m.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
    )
    expect(withReturn.length).toBeGreaterThan(0)
  })

  it('leaves the scripts and workflow libraries under lint', () => {
    const excluded = new Set(Object.keys(EXCLUDED).flatMap((glob) => trackedMatching(glob)))
    const linted = [
      ...trackedMatching('.claude/scripts/**/*.mjs'),
      ...trackedMatching('.claude/workflows/lib/*.mjs'),
    ].filter((file) => !excluded.has(file))
    // A count far below the real surface means the pathspec missed, not that
    // the guard passed.
    expect(linted.length).toBeGreaterThan(60)
  })
})
