// wrangler is installed from two places that nothing else ties together:
// apps/web (what `preview:pages` runs, resolved from the workspace lockfile)
// and the deploy tooling under .github/deploy (what production deploys run,
// an exact pin outside the workspace). Dependabot bumps them as separate
// PRs, so a local preview can drift onto a different wrangler than the one
// that ships. This holds the two resolved versions equal.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

type WorkspaceLock = {
  importers?: Record<
    string,
    Record<string, Record<string, { specifier?: string; version?: string }> | undefined>
  >
}

/** The version pnpm resolved for a workspace's wrangler, without its peer-suffix. */
function resolvedWorkspaceWrangler(lockSource: string, importer: string): string | undefined {
  const lock = parseYaml(lockSource) as WorkspaceLock
  const entry = ['dependencies', 'devDependencies']
    .map((field) => lock.importers?.[importer]?.[field]?.wrangler)
    .find((candidate) => candidate !== undefined)
  return entry?.version?.replace(/\(.*$/, '')
}

describe('wrangler versions agree', () => {
  const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), 'utf-8')

  it('resolves the same version in apps/web and in the deploy tooling', () => {
    const webResolved = resolvedWorkspaceWrangler(read('pnpm-lock.yaml'), 'apps/web')
    const deployPinned = (
      JSON.parse(read('.github/deploy/package.json')) as { dependencies?: Record<string, string> }
    ).dependencies?.wrangler
    expect(webResolved, 'apps/web resolves a wrangler in pnpm-lock.yaml').toMatch(/^\d+\.\d+\.\d+/)
    expect(deployPinned, 'the deploy tooling pins wrangler').toMatch(/^\d+\.\d+\.\d+$/)
    expect(webResolved).toBe(deployPinned)
  })

  it('reads a resolved version whatever peer suffix the lockfile adds', () => {
    const lock = [
      'importers:',
      '  apps/web:',
      '    devDependencies:',
      '      wrangler:',
      '        specifier: ^4.1.0',
      '        version: 4.1.0(@types/node@24.0.0)',
    ].join('\n')
    expect(resolvedWorkspaceWrangler(lock, 'apps/web')).toBe('4.1.0')
    expect(resolvedWorkspaceWrangler(lock, 'apps/other')).toBeUndefined()
  })
})
