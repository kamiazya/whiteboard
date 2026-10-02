import ts from '@typescript/typescript6'
import type { SubpathPolicy } from './architecture-map.js'
import { collectModuleSpecifiers } from './scanner.js'

/** A shipped source file, and what it says. `path` is repo-relative and `/`-separated. */
export interface SubpathScanFile {
  readonly path: string
  readonly text: string
}

/** The workspace directory a repo-relative path sits in: `packages/<name>` or `apps/<name>`. */
export function workspaceOf(path: string): string {
  return path.split('/').slice(0, 2).join('/')
}

/**
 * Whether a file ships: not a test, a bench, a `_test-*` helper, or anything
 * under a `test-utils/` or `testing/` directory, whose job is to be imported
 * by tests.
 */
export function isShippedSourcePath(path: string): boolean {
  return (
    !/\.(test|spec)\.tsx?$/.test(path) &&
    !/\.bench\.tsx?$/.test(path) &&
    !/(?:^|\/)_test-[^/]*$/.test(path) &&
    !/(?:^|\/)(?:test-utils|testing)\//.test(path)
  )
}

/** `<file> imports <specifier>` for each import of a policed subpath by a workspace not allowed it. */
export function findSubpathConsumerViolations(
  files: readonly SubpathScanFile[],
  policy: Readonly<Record<string, SubpathPolicy>>,
): string[] {
  const violations: string[] = []
  for (const { path, text } of files) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    for (const { specifier } of collectModuleSpecifiers(source)) {
      const entry = policy[specifier]
      if (entry === undefined || entry.consumers.includes(workspaceOf(path))) continue
      const who = entry.consumers.length === 0 ? 'tests only' : entry.consumers.join(', ')
      violations.push(`${path} imports ${specifier} (allowed from: ${who})`)
    }
  }
  return violations
}

/** The workspaces whose shipped source imports each policed subpath. */
export function subpathConsumers(
  files: readonly SubpathScanFile[],
  policy: Readonly<Record<string, SubpathPolicy>>,
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  for (const { path, text } of files) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    for (const { specifier } of collectModuleSpecifiers(source)) {
      if (!(specifier in policy)) continue
      found.set(specifier, (found.get(specifier) ?? new Set()).add(workspaceOf(path)))
    }
  }
  return found
}
