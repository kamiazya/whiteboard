// A CODEOWNERS pattern that matches no tracked file protects nothing and
// reads as protection: GitHub does not warn about a rule whose file is gone,
// so a rule for a deleted security-sensitive file keeps listing the owner
// while the file that replaced it sits under only the broader line above.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { trackedFiles } from '../../shared/test-utils/tracked-files.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** A CODEOWNERS pattern as an anchored regex over repo-relative paths. */
function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/')
  const body = pattern
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*|\*/g, (glob) => (glob === '**' ? '.*' : '[^/]*'))
  // A bare name matches at any depth, and a path with no glob also owns what is under it.
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`)
}

const patterns = readFileSync(join(ROOT, '.github/CODEOWNERS'), 'utf-8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map((line) => line.split(/\s+/)[0] ?? '')
  .filter((pattern) => pattern !== '*')

describe('every CODEOWNERS pattern still names something', () => {
  const files = trackedFiles(ROOT)

  it('reads the rules and the tree it matches them against', () => {
    expect(patterns.length).toBeGreaterThan(10)
    expect(files.length).toBeGreaterThan(1000)
  })

  // The matcher is hand-written, so it is held to a pattern of each shape
  // that must match and one that must not — a regex that matched nothing
  // would call every rule dead, and one that matched everything, none.
  it('matches anchored files, globs and directories as CODEOWNERS does', () => {
    const match = (pattern: string, file: string) => patternToRegExp(pattern).test(file)
    expect(match('/package.json', 'package.json')).toBe(true)
    expect(match('/package.json', 'packages/x/package.json')).toBe(false)
    expect(match('/a/b/**', 'a/b/c/d.ts')).toBe(true)
    expect(match('/a/*.ts', 'a/c/d.ts')).toBe(false)
    expect(match('/a/b/**', 'a/other/x.ts')).toBe(false)
  })

  it('no pattern matches zero tracked files', () => {
    const dead = patterns.filter((pattern) => {
      const re = patternToRegExp(pattern)
      return !files.some((file) => re.test(file))
    })
    expect(dead, 'delete the rule, or point it at the file that replaced the deleted one').toEqual(
      [],
    )
  })
})
