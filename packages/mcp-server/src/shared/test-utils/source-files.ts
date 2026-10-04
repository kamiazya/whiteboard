import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface ProductionSourceOptions {
  /** Directory names never descended into, at any depth. */
  readonly skipDirs?: readonly string[]
  /** File extensions taken, dot included. `.ts` and `.tsx` when omitted. */
  readonly extensions?: readonly string[]
  /**
   * Take the `_test-*` / `test-helpers` / `*.smoke-impl.*` modules too. For a
   * guard whose subject is something those drivers do as well: an environment
   * variable a smoke sets is real operator surface.
   */
  readonly includeHarnesses?: boolean
}

const DEFAULT_EXTENSIONS: readonly string[] = ['.ts', '.tsx']

function isTestFile(name: string): boolean {
  return name.includes('.test.')
}

/**
 * A module whose only job is to serve a test: a `_test-*` or `test-helpers`
 * harness a test imports, or a `*.smoke-impl.*` driver a smoke script runs.
 * Not a source the shipped package executes, so a guard that asks what
 * production code does must not count what they do.
 */
function isHarness(name: string): boolean {
  return (
    name.startsWith('_test-') || name.startsWith('test-helpers.') || name.includes('.smoke-impl.')
  )
}

/**
 * Every source file under `dir` that production code could run — what a guard
 * walks when it asks "who calls this" or "who names that". One definition, so
 * nine guards cannot disagree about what a test file is: they had, each
 * spelling the extension and the `.test.` rule its own way, and none skipped
 * the harnesses.
 */
export function productionSourceFiles(
  dir: string,
  options: ProductionSourceOptions = {},
): string[] {
  const { skipDirs = [], extensions = DEFAULT_EXTENSIONS, includeHarnesses = false } = options
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return skipDirs.includes(entry.name) ? [] : productionSourceFiles(path, options)
    }
    return extensions.some((extension) => entry.name.endsWith(extension)) &&
      !isTestFile(entry.name) &&
      (includeHarnesses || !isHarness(entry.name))
      ? [path]
      : []
  })
}
