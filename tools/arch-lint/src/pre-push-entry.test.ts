/**
 * These scans are reachable before a push, not only in CI.
 *
 * Every guard in this package governs code that lives somewhere ELSE — the
 * sleep ledger, the lazy-import check, the vocabulary check, the title check,
 * the boundary and cycle scans all read other packages' source. So the person
 * who breaks one of these rules is, by construction, working in a project that
 * does not run the guard: a fixed sleep added to an `mcp-server` test leaves
 * `--project mcp-node` green and fails `arch-lint-node`.
 *
 * `.claude/rules/dev-flow.md` recorded that gap in prose, and prose cannot
 * notice being forgotten — it was forgotten twice on one branch, by the person
 * who had written it down, each time costing a push that CI rejected.
 *
 * Asserted here rather than in a test about lefthook, for the reason
 * `file-size-budget.test.ts` gives for the same shape: this is the package that
 * knows WHY the entry has to exist. What it pins is the entry AND the claim
 * underneath it, because an entry justified by a reason nobody checks is the
 * next thing to go stale.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEST_SCAN_DIRS } from './test-scan-dirs.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** The `run:` commands under lefthook.yml's `pre-push:` block. */
function prePushCommands(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'lefthook.yml'), 'utf8')
  const start = text.indexOf('\npre-push:')
  if (start === -1) throw new Error('lefthook.yml has no `pre-push:` block')
  const rest = text.slice(start + 1)
  const nextTopLevel = rest.slice('pre-push:'.length).search(/\n(?=[A-Za-z_-]+:)/)
  const block = nextTopLevel === -1 ? rest : rest.slice(0, 'pre-push:'.length + nextTopLevel)
  return [...block.matchAll(/^ {6}run: (.+)$/gm)].map((match) => match[1].trim())
}

describe('the architecture scans run before a push', () => {
  // A scan that stops matching reports its subject as satisfied — the same
  // shape as a passing run. Checked before anything is concluded from it.
  it('reads the pre-push block', () => {
    expect(prePushCommands().length).toBeGreaterThanOrEqual(5)
  })

  it('is run by a pre-push command', () => {
    const runsThisProject = prePushCommands().filter((command) =>
      command.includes('--project arch-lint-node'),
    )
    expect(runsThisProject).toHaveLength(1)
  })

  /**
   * The reason, kept true rather than merely written down: these scans read
   * other packages. A floor rather than an exact count, so adding a package
   * does not fail this — only the rationale genuinely collapsing does.
   *
   * `packages/mcp-server/src` is named because that is where both defects
   * that earned the pre-push entry landed. If it ever leaves this list, the
   * entry's justification leaves with it and should be re-argued.
   */
  it('governs packages other than its own', () => {
    const elsewhere = TEST_SCAN_DIRS.filter((dir) => !dir.startsWith('tools/'))
    expect(elsewhere.length).toBeGreaterThan(1)
    expect(elsewhere).toContain('packages/mcp-server/src')
  })
})
