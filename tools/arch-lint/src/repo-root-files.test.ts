/**
 * The repository root holds project configuration and nothing else.
 *
 * This exists because 58 binary Loro snapshots were once committed here in
 * one `git add -A`. They were debris from a window in which a store wrote a
 * blob to `writeFile(path, snapshot)` — the DOCUMENT path — instead of to the
 * blob path, so each one landed at the repo root named after a canvas: `a`,
 * `foo`, `canvas-1`, `notes/2026/plan`. The writing bug was found and fixed;
 * what nothing caught was the debris going into a commit, and it stayed
 * unnoticed until a review bot listed the changed files.
 *
 * `git ls-files` rather than a directory scan on purpose: the failure mode is
 * junk being TRACKED, and scanning the working tree instead would fail on
 * anyone's local scratch file, which is noise rather than a defect.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/**
 * Every file the root is allowed to track. A new entry here should be a
 * deliberate project-configuration decision — if you are adding one to make
 * this test pass, the file probably belongs in a package instead.
 */
const ALLOWED_ROOT_FILES: ReadonlySet<string> = new Set([
  '.dockerignore',
  '.env.server.example',
  '.gitignore',
  '.mcp.json',
  '.node-version',
  '.npmrc',
  '.pinact.yaml',
  '.release-please-manifest.json',
  '.secretlintignore',
  '.secretlintrc.json',
  'AGENTS.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'Dockerfile.server',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'biome.json',
  'docker-compose.server.yml',
  'gemini-extension.json',
  'knip.jsonc',
  'lefthook.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'release-please-config.json',
  'server.json',
  // The one definition of the browser-mode project config, spread by the
  // three vitest.browser.config.ts files. Root on purpose: it sits beside
  // vitest.config.ts (which registers those projects) and belongs to no
  // single package.
  'vitest.browser.shared.ts',
  'vitest.config.ts',
])

function trackedRootFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf-8' })
  return out
    .split('\0')
    .filter((name) => name !== '' && !name.includes('/'))
    .sort()
}

describe('repository root', () => {
  it('tracks project configuration and nothing else', () => {
    const unexpected = trackedRootFiles().filter((name) => !ALLOWED_ROOT_FILES.has(name))
    expect(unexpected).toEqual([])
  })

  it('has no stale entry in the allowlist', () => {
    // A name left here after its file goes away is how an allowlist rots into
    // permission for something nobody meant to allow.
    const tracked = new Set(trackedRootFiles())
    const stale = [...ALLOWED_ROOT_FILES].filter((name) => !tracked.has(name)).sort()
    expect(stale).toEqual([])
  })
})
