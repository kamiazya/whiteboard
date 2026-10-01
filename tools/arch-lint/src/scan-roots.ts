import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What a source scan needs to know about THIS checkout before it reads a
 * file: where the root is, which source trees are scanned, which directories
 * inside them are not this repo's code, and how to list what is left.
 *
 * One definition because the copies disagreed in the way copies do. Five
 * `walk`s existed, each answering a slightly different question (does a
 * `.git` FILE get entered, is a symlink followed, does `.claude/worktrees`
 * count as the repo), and the size ledgers kept their own `SCAN_ROOTS` and
 * exclusion list word for word. What differs between callers is the FILTER,
 * so that is the parameter; the traversal is shared.
 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/**
 * `.claude/worktrees/` holds whole checkouts of other branches, gitignored
 * and per-machine. Walking into one reports that branch's copy of every
 * surface, so a developer's parallel work blocks a push of code that is
 * itself fine. Matched by path from a walk's root, because `worktrees`
 * alone is a name other directories may legitimately carry.
 */
export const WORKTREES_PATH = '.claude/worktrees'

/** The `src` directory of every package/tool matching a `<group>/*` glob that has one. */
function groupSrcDirs(group: string): string[] {
  return readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(group, entry.name, 'src'))
    .filter((relDir) => existsSync(join(REPO_ROOT, relDir)))
}

/** The source trees the size ledgers scan, relative to the repo root. */
export const SCAN_ROOTS: readonly string[] = [
  'apps/web/src',
  ...groupSrcDirs('packages'),
  ...groupSrcDirs('tools'),
]

/**
 * Directories excluded WHOLE, with the reason a scan there would be noise
 * rather than debt.
 *
 * `migrations/` is history — a migration's own text does not change once
 * written (see .claude/rules/vocabulary.md). `vendor/budoux/` is a vendored
 * third-party file (`ja-model.ts`, a generated data table copied from the
 * `budoux` package — see its own README for why it is vendored rather than
 * depended on); its size is not this repo's code to shrink. A worktree is
 * another branch's checkout (`WORKTREES_PATH`).
 */
const EXCLUDED_DIR_SEGMENTS: readonly string[] = [
  '/migrations/',
  '/vendor/budoux/',
  `/${WORKTREES_PATH}/`,
]

/**
 * The repo-relative path in the form the size ledgers are keyed with.
 *
 * Normalised because the ledgers hold forward slashes and `join` produces
 * backslashes on Windows, where an unnormalised key matches nothing — so
 * every listed file would be reported as unlisted, which reads as the guard
 * finding real debt.
 */
export function relativeToRepo(absolutePath: string, root: string = REPO_ROOT): string {
  return absolutePath.slice(root.length + 1).replaceAll('\\', '/')
}

/**
 * Whether a path sits in an excluded directory. Judged on the path RELATIVE
 * to the repo, never the absolute one: this checkout may itself live under
 * `.claude/worktrees/`, and an absolute match would then exclude everything.
 */
export function isExcludedPath(absolutePath: string, root: string = REPO_ROOT): boolean {
  const relative = `/${relativeToRepo(absolutePath, root)}`
  return EXCLUDED_DIR_SEGMENTS.some((segment) => relative.includes(segment))
}

export interface WalkOptions {
  /** Keep a file in the result. Default: every file. */
  readonly include?: (absolutePath: string) => boolean
  /**
   * Do not enter (or list) an entry, judged on its name and full path before
   * it is stat'ed — so it applies to files as well as directories. A nested
   * worktree's `.git` is a file, and a skip list keyed on the name has to
   * reach it.
   */
  readonly skip?: (absolutePath: string, name: string) => boolean
}

/** Every file under `dir` passing `include`, in directory order, following symlinks. */
export function walk(dir: string, options: WalkOptions = {}, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (options.skip?.(full, name) === true) continue
    if (statSync(full).isDirectory()) walk(full, options, found)
    else if (options.include === undefined || options.include(full)) found.push(full)
  }
  return found
}
