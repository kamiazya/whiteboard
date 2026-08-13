// PostToolUse(Bash) hook: after a successful `gh pr merge`, fast-forward the
// main checkout to origin/main so the next branch/worktree never starts from a
// stale base. Deterministic enforcement of what used to be a prompt-level rule
// (see .claude/rules/integrator-flow.md).
//
// Receives the hook JSON on stdin. Exits 0 silently for every non-matching
// tool call so it adds no noise to unrelated Bash usage.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** A few concurrent lanes are the normal working shape; a pile is debris. */
const LANE_NOTICE_THRESHOLD = 5

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const raw = readStdin()
let input
try {
  input = JSON.parse(raw)
} catch {
  process.exit(0)
}

const command = input?.tool_input?.command ?? ''
if (!/\bgh\s+pr\s+merge\b/.test(command)) process.exit(0)

/** Set by the sync block below so the lane notice can reuse it. */
let mainCheckout

try {
  // Resolve the main checkout root even if the merge ran from a linked worktree.
  const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const repoRoot = resolve(process.cwd(), commonDir, '..')
  mainCheckout = repoRoot
  const current = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  if (current !== 'main') {
    console.log(`[post-merge-pull-main] main checkout is on '${current}', skipping pull`)
    process.exit(0)
  }
  execFileSync('git', ['-C', repoRoot, 'pull', '--ff-only', 'origin', 'main'], { encoding: 'utf8' })
  const head = execFileSync('git', ['-C', repoRoot, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim()
  console.log(`[post-merge-pull-main] local main synced: ${head}`)
} catch (err) {
  // Never block the session on sync failure (dirty tree, diverged main, offline);
  // surface it so the integrator handles it deliberately.
  console.log(`[post-merge-pull-main] pull skipped: ${err?.message?.split('\n')[0] ?? 'unknown error'}`)
}

// A merge is the moment a lane becomes reclaimable, so it is the moment to
// say so. DETECTION ONLY, and deliberately cheap: this counts directories
// rather than asking cleanup-worktrees.mjs, which fetches. Deleting
// directories as a side effect of a merge is not a hook's business — the
// session runs the cleanup when it chooses.
try {
  if (mainCheckout !== undefined) {
    const dir = join(mainCheckout, '.claude', 'worktrees')
    const lanes = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()) : []
    if (lanes.length >= LANE_NOTICE_THRESHOLD) {
      console.log(
        `[post-merge-pull-main] ${lanes.length} worktrees under .claude/worktrees — node .claude/scripts/cleanup-worktrees.mjs --dry-run`,
      )
    }
  }
} catch {
  /* never block the session on a notice */
}
process.exit(0)
