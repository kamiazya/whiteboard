// The root vitest project list is data (vitest.projects.json): the root
// config imports it, and every guard or CI script that needs the list parses
// it through tools/checks/src/vitest-projects.mjs. Reading the root config as
// text instead recovers the list with a quote-matching regex, which a comment
// carrying an apostrophe or a quoted path silently corrupts — one reader then
// counts a phantom project, another opens a path made of the comment.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

// lazy-import: loaded by path, since a relative import of the root config and
// of tools/checks leaves this workspace and `relative-import-escape` refuses it.
const rootConfig = (
  (await import(pathToFileURL(join(REPO_ROOT, 'vitest.config.ts')).href)) as {
    default: { test?: { projects?: unknown } }
  }
).default
const { readVitestProjectConfigPaths } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/vitest-projects.mjs')).href
)) as { readVitestProjectConfigPaths: (repoRoot: string) => string[] }

/** A read of the ROOT vitest.config.ts as text: `readFileSync(join(<root>, 'vitest.config.ts')`. */
const TEXT_READ_OF_ROOT_CONFIG =
  /readFileSync\(\s*(?:(?:join|resolve)\(\s*(?:ROOT|REPO_ROOT|repoRoot|root)\s*,\s*)?['"`](?:\.\/)?vitest\.config\.ts['"`]/

const SELF = 'tools/arch-lint/src/root-vitest-projects.test.ts'

describe('root vitest project list', () => {
  it('is what the loaded root config registers', () => {
    const shared = readVitestProjectConfigPaths(REPO_ROOT)
    expect(shared.length).toBeGreaterThan(20)
    expect(rootConfig.test?.projects).toEqual(shared)
  })

  it('is never recovered by reading the root config as text', () => {
    const scripts = trackedFiles(REPO_ROOT, '*.ts', '*.tsx', '*.mjs', '*.js', '*.cjs').filter(
      (file) => file !== SELF && !file.includes('/fixtures/'),
    )
    expect(scripts.length).toBeGreaterThan(500)
    const offenders = scripts.filter((file) =>
      TEXT_READ_OF_ROOT_CONFIG.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
    )
    expect(
      offenders,
      'read the list through readVitestProjectConfigPaths (tools/checks/src/vitest-projects.mjs)',
    ).toEqual([])
  })

  it('recognises the text reads it forbids, and leaves per-package reads alone', () => {
    for (const read of [
      "readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8')",
      "readFileSync(join(ROOT, 'vitest.config.ts'), 'utf-8')",
      'readFileSync(join(repoRoot, "vitest.config.ts"), "utf8")',
      "readFileSync('vitest.config.ts', 'utf8')",
    ]) {
      expect(TEXT_READ_OF_ROOT_CONFIG.test(read), read).toBe(true)
    }
    for (const read of [
      "readFileSync(join(REPO_ROOT, dir, 'vitest.config.ts'), 'utf-8')",
      "readFileSync(join(REPO_ROOT, 'apps/web/vitest.config.ts'), 'utf8')",
      "await import(pathToFileURL(join(REPO_ROOT, 'vitest.config.ts')).href)",
    ]) {
      expect(TEXT_READ_OF_ROOT_CONFIG.test(read), read).toBe(false)
    }
  })
})
