import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXCLUDED_DIR_SEGMENTS,
  isExcludedPath,
  REPO_ROOT,
  REPO_SOURCE_ROOTS,
  REPO_SOURCE_SKIPPED_DIRS,
  readRepoSources,
  readWorkspaceEntries,
  SCAN_ROOTS,
  scriptFiles,
  scriptTypeScriptFiles,
  WORKTREES_PATH,
  walk,
  workspaceDirs,
} from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

describe('scan roots', () => {
  it('reaches every app, package and tool source tree', () => {
    // A derivation that matched nothing would leave every size scan reading an
    // empty tree, which reports as a clean one.
    expect(SCAN_ROOTS).toContain('apps/web/src')
    expect(SCAN_ROOTS).toContain(join('tools', 'arch-lint', 'src'))
    expect(SCAN_ROOTS.length).toBeGreaterThan(15)
  })

  it('reaches the src tree of every workspace that has one, whichever group it is in', () => {
    // `apps/web` was named and `apps/*` was not derived, so a second app's
    // source sat outside every size and import-position scan that walks these.
    const unreached = workspaceDirs()
      .filter((dir) => existsSync(join(REPO_ROOT, dir, 'src')))
      .map((dir) => join(dir, 'src'))
      .filter((root) => !SCAN_ROOTS.includes(root))
    expect(unreached).toEqual([])
  })

  it('lists the scripts of every tree that holds one, and no dependency or build output', () => {
    // The one list the entry-module check, the serve-dist check and the size
    // ledger read: an app's scripts, the smokes, a tool's top-level script and
    // the dev tooling were each outside one of the three when they kept their own.
    const scripts = scriptFiles()
    expect(scripts).toEqual(
      expect.arrayContaining([
        'apps/web/scripts/smoke-pwa-lifecycle.mjs',
        'packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs',
        'tests/e2e/distribution/smoke-helpers.mjs',
        'tools/check-pr-title.mjs',
        'tools/checks/src/is-run-as-script.mjs',
        '.claude/scripts/new-worktree.mjs',
      ]),
    )
    expect(scripts.filter((path) => /(^|\/)(node_modules|dist)\//.test(path))).toEqual([])
  })

  it('lists the TypeScript outside every source tree, and nothing a source tree holds', () => {
    const files = scriptTypeScriptFiles()
    expect(files).toEqual(
      expect.arrayContaining([
        'packages/mcp-server/scripts/dev/dev-daemon-socket-lib.test.ts',
        'apps/web/scripts/strip-wasm-sourcemap.ts',
        'apps/web/vite.config.ts',
        '.claude/scripts/fixtures/biome-plugin/good.test.tsx',
      ]),
    )
    const roots = SCAN_ROOTS.map((root) => `${root.replaceAll('\\', '/')}/`)
    expect(files.filter((path) => roots.some((root) => path.startsWith(root)))).toEqual([])
    expect(files.filter((path) => /\.d\.(m|c)?ts$/.test(path))).toEqual([])
  })

  it('leaves no tracked TypeScript below the repo root outside both size scans', () => {
    // The `.mjs`-only script scan once left every `.ts` script in no ledger,
    // and a scan that reads nothing reads exactly like a clean tree. The repo
    // root's own configs sit outside every script root, `.mjs` and `.ts` alike.
    const roots = SCAN_ROOTS.map((root) => `${root.replaceAll('\\', '/')}/`)
    const scanned = new Set(scriptTypeScriptFiles())
    expect(scanned.size).toBeGreaterThan(100)
    const unscanned = trackedFiles(REPO_ROOT, '*.ts', '*.tsx', '*.mts', '*.cts')
      .filter((file) => file.includes('/') && !/\.d\.(m|c)?ts$/.test(file))
      .filter((file) => !roots.some((root) => file.startsWith(root)))
      .filter((file) => !isExcludedPath(join(REPO_ROOT, file)))
      .filter((file) => !scanned.has(file))
    expect(unscanned).toEqual([])
  })

  it('excludes history, vendored and worktree directories by their path inside the repo', () => {
    expect(
      isExcludedPath(join(REPO_ROOT, 'packages/mcp-server/src/server/store/db/migrations/0001.ts')),
    ).toBe(true)
    expect(isExcludedPath(join(REPO_ROOT, 'packages/canvas-render/src/vendor/budoux/ja.ts'))).toBe(
      true,
    )
    expect(isExcludedPath(join(REPO_ROOT, WORKTREES_PATH, 'other/packages/x/src/a.ts'))).toBe(true)
    expect(isExcludedPath(join(REPO_ROOT, 'packages/x/src/a.ts'))).toBe(false)
  })

  it('does not exclude a directory that only shares the name of an excluded one', () => {
    expect(isExcludedPath(join(REPO_ROOT, 'packages/x/src/migrations/0001.ts'))).toBe(false)
    expect(isExcludedPath(join(REPO_ROOT, 'packages/x/src/vendor/budoux/ja.ts'))).toBe(false)
  })

  // Guarded from both sides: an entry for a directory that was moved or
  // deleted excuses nothing, and reads exactly like an exclusion in force.
  it('lists no directory that does not exist', () => {
    const missing = EXCLUDED_DIR_SEGMENTS.filter(
      (segment) => segment !== `/${WORKTREES_PATH}/` && !existsSync(join(REPO_ROOT, segment)),
    )
    expect(missing).toEqual([])
    expect(EXCLUDED_DIR_SEGMENTS.length).toBeGreaterThan(2)
  })

  it('does not read where the checkout lives as part of the path it judges', () => {
    // A checkout may itself sit under `.claude/worktrees/`; matching the
    // absolute path would then exclude every file in it.
    const root = `/home/dev/repo/${WORKTREES_PATH}/feature`
    expect(isExcludedPath(`${root}/packages/x/src/a.ts`, root)).toBe(false)
    expect(
      isExcludedPath(`${root}/packages/mcp-server/src/server/store/db/migrations/0001.ts`, root),
    ).toBe(true)
  })
})

describe('walk', () => {
  const withTree = (run: (root: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), 'scan-roots-walk-'))
    try {
      mkdirSync(join(root, 'a', 'deep'), { recursive: true })
      mkdirSync(join(root, 'skipped'), { recursive: true })
      writeFileSync(join(root, 'a', 'one.ts'), '')
      writeFileSync(join(root, 'a', 'deep', 'two.test.ts'), '')
      writeFileSync(join(root, 'skipped', 'three.ts'), '')
      writeFileSync(join(root, '.git'), 'gitdir: elsewhere')
      run(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const names = (root: string, paths: readonly string[]): string[] =>
    paths.map((path) => path.slice(root.length + 1).replaceAll('\\', '/')).sort()

  it('lists every file at any depth when given no options', () => {
    withTree((root) => {
      expect(names(root, walk(root))).toEqual([
        '.git',
        'a/deep/two.test.ts',
        'a/one.ts',
        'skipped/three.ts',
      ])
    })
  })

  it('keeps only the files `include` accepts', () => {
    withTree((root) => {
      expect(names(root, walk(root, { include: (path) => !path.endsWith('.test.ts') }))).toEqual([
        '.git',
        'a/one.ts',
        'skipped/three.ts',
      ])
    })
  })

  it('applies `skip` to files as well as directories', () => {
    withTree((root) => {
      const found = walk(root, { skip: (_path, name) => name === 'skipped' || name === '.git' })
      expect(names(root, found)).toEqual(['a/deep/two.test.ts', 'a/one.ts'])
    })
  })
})

describe('readRepoSources', () => {
  const sources = readRepoSources()

  it('names only roots that exist, and reads source under each that holds any', () => {
    // A root that does not exist reads like coverage and reaches nothing, the
    // way an exclusion that names a missing directory excuses nothing.
    expect(REPO_SOURCE_ROOTS.filter((root) => !existsSync(join(REPO_ROOT, root)))).toEqual([])
    for (const root of [
      'apps',
      'packages',
      'tools',
      'tests',
      '.claude/scripts',
      '.claude/workflows',
    ]) {
      expect(
        sources.some((file) => file.path.startsWith(`${root}/`)),
        root,
      ).toBe(true)
    }
    expect(sources.length).toBeGreaterThan(2500)
    expect(sources.some((file) => /\.d\.m?ts$/.test(file.path))).toBe(false)
    expect(sources.some((file) => file.path.includes('/migrations/'))).toBe(false)
  })
})

describe('readRepoSources over a fixture checkout', () => {
  it('reads a directory that only shares an excluded name, and skips the excluded path', () => {
    // An importer guard that skipped every `migrations` or `worktrees` by name
    // would ignore a caller living there, and report the name it uses as dead.
    // The vendored directory ships, so what it imports is in use and it is read.
    const root = mkdtempSync(join(tmpdir(), 'scan-roots-sources-'))
    try {
      for (const dir of REPO_SOURCE_ROOTS) mkdirSync(join(root, dir), { recursive: true })
      const files = [
        'apps/x/src/migrations/kept.ts',
        'packages/x/src/worktrees/kept.ts',
        'packages/mcp-server/src/server/store/db/migrations/0001.ts',
        'packages/canvas-render/src/vendor/budoux/ja.ts',
        'packages/x/node_modules/dep/index.js',
      ]
      for (const file of files) {
        mkdirSync(join(root, file, '..'), { recursive: true })
        writeFileSync(join(root, file), '')
      }
      expect(
        readRepoSources(root)
          .map((file) => file.path)
          .sort(),
      ).toEqual([
        'apps/x/src/migrations/kept.ts',
        'packages/canvas-render/src/vendor/budoux/ja.ts',
        'packages/x/src/worktrees/kept.ts',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the script scan over a fixture checkout', () => {
  it('reads nothing under a .wrangler directory, whatever wrangler names inside it', () => {
    // `wrangler pages dev` writes bundles there, gitignored; read by the size
    // ledger, a large one would block a push of code that is itself fine.
    const root = mkdtempSync(join(tmpdir(), 'scan-roots-scripts-'))
    try {
      const files = [
        'apps/web/scripts/kept.mjs',
        'apps/web/scripts/kept.ts',
        'apps/web/.wrangler/pages-shim.js',
        'apps/web/.wrangler/state/v3/entry.ts',
      ]
      for (const file of files) {
        mkdirSync(join(root, file, '..'), { recursive: true })
        writeFileSync(join(root, file), '')
      }
      for (const dir of ['packages', 'tests', 'tools', '.claude/scripts']) {
        mkdirSync(join(root, dir), { recursive: true })
      }
      expect(scriptFiles(root)).toEqual(['apps/web/scripts/kept.mjs'])
      expect(scriptTypeScriptFiles(root)).toEqual(['apps/web/scripts/kept.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('readWorkspaceEntries', () => {
  it('maps every package entry to the source file it lands on', () => {
    const entries = readWorkspaceEntries()
    expect(entries.size).toBeGreaterThan(40)
    expect(entries.get('@kamiazya/whiteboard-ports')).toBe('packages/ports/src/index.ts')
  })
})

// A name in the skip set is a directory the walk would otherwise enter: one
// git tracks (`migrations`) or one it ignores (build output, a nested checkout).
// A name that is neither skips nothing and reads exactly like a skip in force.
describe('the directories readRepoSources skips', () => {
  // `.git` is git's own, and a nested checkout's is a file git never lists.
  const GIT_METADATA = '.git'
  const PREFIXES = ['', '.claude/', ...REPO_SOURCE_ROOTS.map((dir) => `${dir}/`)]

  it('each exist as a tracked directory or are ignored by git', () => {
    const tracked = new Set(
      trackedFiles(REPO_ROOT, ...REPO_SOURCE_ROOTS).flatMap((file) => file.split('/').slice(0, -1)),
    )
    const probes = [...REPO_SOURCE_SKIPPED_DIRS].flatMap((name) =>
      PREFIXES.map((prefix) => ({ name, path: `${prefix}${name}/probe` })),
    )
    const ignored = new Set(
      spawnSync('git', ['check-ignore', '--stdin'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        input: probes.map((probe) => probe.path).join('\n'),
      })
        .stdout.split('\n')
        .filter((line) => line !== ''),
    )
    const stale = [...REPO_SOURCE_SKIPPED_DIRS].filter(
      (name) =>
        name !== GIT_METADATA &&
        !tracked.has(name) &&
        !probes.some((probe) => probe.name === name && ignored.has(probe.path)),
    )
    expect(
      stale,
      'drop the name from REPO_SOURCE_SKIPPED_DIRS: nothing by that name is tracked or ignored',
    ).toEqual([])
    expect(tracked.size).toBeGreaterThan(100)
  })
})
