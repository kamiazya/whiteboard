import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXCLUDED_DIR_SEGMENTS,
  isExcludedPath,
  REPO_ROOT,
  SCAN_ROOTS,
  SCRIPT_SCAN_ROOTS,
  WORKTREES_PATH,
  walk,
  workspaceDirs,
} from './scan-roots.js'

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

  it('reaches the end-to-end tree and every package scripts directory', () => {
    expect(SCRIPT_SCAN_ROOTS).toContain('tests')
    expect(SCRIPT_SCAN_ROOTS).toContain(join('packages', 'mcp-server', 'scripts'))
    expect(SCRIPT_SCAN_ROOTS.length).toBeGreaterThan(2)
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
