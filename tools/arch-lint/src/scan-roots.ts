import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceEntries } from './module-exports-resolve.js'

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
const WORKTREES_SEGMENT = `/${WORKTREES_PATH}/`
const MIGRATIONS_SEGMENT = '/packages/mcp-server/src/server/store/db/migrations/'

/** The three top-level groups `pnpm-workspace.yaml` globs: `packages/*`, `apps/*`, `tools/*`. */
const WORKSPACE_GROUPS = ['packages', 'apps', 'tools'] as const

/**
 * Every workspace directory (`<group>/<name>`, repo-relative, `/`-separated)
 * that carries a `package.json`, enumerated from the three groups above rather
 * than listed — a workspace added to one of them joins every guard that walks
 * this.
 */
export function workspaceDirs(): string[] {
  return WORKSPACE_GROUPS.flatMap((group) =>
    readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`)
      .filter((dir) => existsSync(join(REPO_ROOT, dir, 'package.json'))),
  )
}

/**
 * Every exported package entry (`@kamiazya/whiteboard-x/sub`) mapped to the
 * repo path of the source file it lands on, read from each workspace manifest.
 */
export function readWorkspaceEntries(): Map<string, string> {
  return workspaceEntries(
    workspaceDirs().map((dir) => ({
      dir,
      text: readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8'),
    })),
  )
}

/**
 * Every tree that may hold a file importing a workspace package: the
 * workspaces, the smokes under `tests/`, and the dev tooling and skills under
 * `.claude/` and `skills/`. Shared by every "has this export got an importer"
 * guard, so they cannot disagree about which files count as one; a guard that
 * read fewer roots would tell someone to delete a name a skipped root uses.
 */
export const REPO_SOURCE_ROOTS: readonly string[] = [
  'apps',
  'packages',
  'tools',
  'tests',
  '.claude/scripts',
  '.claude/workflows',
  '.claude/skills',
  'skills',
]

/**
 * Directory NAMES `readRepoSources` never enters, each one a name that is never
 * this repo's source wherever it appears: `node_modules` is installed
 * dependencies, `dist` and `coverage` are build and report output, `tmp` is
 * scratch (a crashed Stryker run leaves a sandbox copy of the source under a
 * package's `tmp`), and `.git` is git's own — a directory in the main checkout,
 * a file in a nested one. History and nested checkouts are skipped by PATH
 * instead (`REPO_SOURCE_EXCLUDED_SEGMENTS`), because `migrations` and
 * `worktrees` are names somebody's code may carry.
 */
export const REPO_SOURCE_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'tmp',
  '.git',
  'coverage',
])

/** A source file as the importer guards read it: repo-relative path and text. */
export interface RepoSource {
  readonly path: string
  readonly text: string
}

/** Every source file under `REPO_SOURCE_ROOTS`, declaration files aside, with its text. */
export function readRepoSources(repoRoot: string = REPO_ROOT): RepoSource[] {
  return REPO_SOURCE_ROOTS.flatMap((root) =>
    walk(join(repoRoot, root), {
      include: (path) => /\.(tsx?|mts|mjs|js|cjs)$/.test(path) && !/\.d\.m?ts$/.test(path),
      skip: (path, name) =>
        REPO_SOURCE_SKIPPED_DIRS.has(name) ||
        isExcludedPath(`${path}/`, repoRoot, REPO_SOURCE_EXCLUDED_SEGMENTS),
    }),
  ).map((path) => ({ path: relativeToRepo(path, repoRoot), text: readFileSync(path, 'utf8') }))
}

/** The `<sub>` directory of every package/tool matching a `<group>/*` glob that has one. */
function groupSubdirs(group: string, sub: string): string[] {
  return readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(group, entry.name, sub))
    .filter((relDir) => existsSync(join(REPO_ROOT, relDir)))
}

/** The source trees the size ledgers scan, relative to the repo root. */
export const SCAN_ROOTS: readonly string[] = [
  ...groupSubdirs('apps', 'src'),
  ...groupSubdirs('packages', 'src'),
  ...groupSubdirs('tools', 'src'),
]

/**
 * The trees that hold plain-Node scripts: package and app `scripts/`, the
 * distribution and end-to-end smokes under `tests/`, the gates under `tools/`
 * and the dev tooling under `.claude/scripts`. Walked whole rather than as
 * one `scripts/` directory per workspace, because a script also lives at
 * `tools/*.mjs` and in a tool's `src`.
 */
const SCRIPT_ROOTS: readonly string[] = ['apps', 'packages', 'tests', 'tools', '.claude/scripts']

/** Directories under those roots that hold no script of this repo's own. */
const SCRIPT_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'tmp',
  '.git',
  'public',
])

/**
 * Every plain-Node script (`.mjs`, `.cjs`, `.js`, tests included), as sorted
 * repo-relative paths. The one list the script guards share — the entry-module
 * check, the serve-dist check and the size ledger's `.mjs` half — so a script cannot
 * sit inside one guard's roots and outside another's; each guard narrows it by
 * its own filter. Kept as separate lists, the size ledger's roots left every
 * app's `scripts/`, `tools/*.mjs` and `.claude/scripts` outside the budget.
 */
export function scriptFiles(): string[] {
  return walkScriptRoots((path) => /\.(mjs|cjs|js)$/.test(path))
}

/**
 * Every TypeScript file under the script trees that no `SCAN_ROOTS` tree
 * holds — a package's `scripts/`, its root-level configs and tests, the
 * dev tooling's fixtures — declaration files aside, tests included. The
 * size ledgers read `SCAN_ROOTS` for TypeScript and `scriptFiles()` for
 * plain Node, so without this list a `.ts` script sat in neither and grew
 * past the budget unwatched.
 */
export function scriptTypeScriptFiles(): string[] {
  const sourceRoots = SCAN_ROOTS.map((root) => `${root.replaceAll('\\', '/')}/`)
  return walkScriptRoots(
    (path) => /\.(m|c)?tsx?$/.test(path) && !/\.d\.(m|c)?ts$/.test(path),
  ).filter((path) => !sourceRoots.some((root) => path.startsWith(root)))
}

function walkScriptRoots(include: (absolutePath: string) => boolean): string[] {
  return SCRIPT_ROOTS.flatMap((root) =>
    walk(join(REPO_ROOT, root), {
      include: (path) => include(path) && !isExcludedPath(path),
      skip: (_path, name) => SCRIPT_SKIPPED_DIRS.has(name),
    }),
  )
    .map((path) => relativeToRepo(path))
    .sort()
}

/**
 * Directories excluded WHOLE, each as its path from the repo root, with the
 * reason a scan there would be noise rather than debt.
 *
 * `migrations/` is history — a migration's own text does not change once
 * written (see .claude/rules/vocabulary.md). `vendor/budoux/` is a vendored
 * third-party file (`ja-model.ts`, a generated data table copied from the
 * `budoux` package — see its own README for why it is vendored rather than
 * depended on); its size is not this repo's code to shrink. A worktree is
 * another branch's checkout (`WORKTREES_PATH`).
 *
 * Full paths, not names: a directory that merely shares the name `migrations`
 * is somebody's code, and was silently dropped from every scan that asks.
 * Each entry but the worktrees (per-machine, gitignored) must name a directory
 * that exists, so an entry cannot outlive the directory it excuses.
 */
export const EXCLUDED_DIR_SEGMENTS: readonly string[] = [
  MIGRATIONS_SEGMENT,
  '/packages/canvas-render/src/vendor/budoux/',
  WORKTREES_SEGMENT,
]

/**
 * The excluded directories the importer guards skip too: a migration's
 * imports are frozen at the point it was written, so a use there keeps
 * nothing alive, and a worktree is another branch's code. The vendored
 * directory is still read — it ships, so a name it imports is in use.
 */
const REPO_SOURCE_EXCLUDED_SEGMENTS: readonly string[] = [MIGRATIONS_SEGMENT, WORKTREES_SEGMENT]

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
export function isExcludedPath(
  absolutePath: string,
  root: string = REPO_ROOT,
  segments: readonly string[] = EXCLUDED_DIR_SEGMENTS,
): boolean {
  const relative = `/${relativeToRepo(absolutePath, root)}`
  return segments.some((segment) => relative.startsWith(segment))
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
