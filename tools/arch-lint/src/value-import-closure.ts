// The transitive VALUE-import closure of a set of entry files: what a bundler
// or a Node process actually loads when it starts from them.
//
// Scans that judge one file at a time (scanner.ts, direction-check.ts) cannot
// see what a re-export DRAGS: a module that is allowed to import its neighbour
// is not thereby allowed to inherit everything the neighbour imports. This
// walk is the shared half of the guards that ask that question, and it owns
// only the traversal — which specifiers are forbidden, and which are followed
// into another file, stay with the caller.
//
// Filesystem-free by design: the caller supplies `read` and `resolve`, so a
// unit test feeds it a fixture graph directly (cycle-check.ts's shape).

import { posix } from 'node:path'
import ts from '@typescript/typescript6'
import { collectModuleSpecifiers } from './scanner.js'

interface ReachedImport {
  readonly from: string
  readonly specifier: string
  readonly line: number
  /** Entry -> ... -> `from`, so a violation names how the entry reaches it. */
  readonly via: readonly string[]
}

export interface ValueImportClosure {
  /** Every file reached, entries included, sorted. */
  readonly files: readonly string[]
  /** Every value import of every reached file, followed or not. */
  readonly imports: readonly ReachedImport[]
  /** Entry -> ... -> `path` for any reached file. */
  readonly chainTo: (path: string) => readonly string[]
}

export interface ClosureHost {
  readonly read: (path: string) => string
  /** The file a specifier loads and the walk should enter, or `null` to stop there. */
  readonly resolve: (fromPath: string, specifier: string) => string | null
}

/**
 * Type-only edges are erased at emit and load nothing, so they are not
 * followed and not reported. The classification is `collectModuleSpecifiers`'s:
 * syntactic, and a named import whose bindings are ALL inline `type` counts
 * as erased (this repo does not set `verbatimModuleSyntax`).
 */
export function walkValueImportClosure(
  entries: readonly string[],
  host: ClosureHost,
): ValueImportClosure {
  const parent = new Map<string, string | null>()
  const imports: ReachedImport[] = []
  const queue: string[] = []
  for (const entry of entries) {
    if (parent.has(entry)) continue
    parent.set(entry, null)
    queue.push(entry)
  }

  const chainTo = (path: string): string[] => {
    const chain: string[] = []
    for (let at: string | null | undefined = path; at != null; at = parent.get(at))
      chain.unshift(at)
    return chain
  }

  for (let next = 0; next < queue.length; next++) {
    const path = queue[next] as string
    const sourceFile = ts.createSourceFile(path, host.read(path), ts.ScriptTarget.Latest, true)
    for (const edge of collectModuleSpecifiers(sourceFile)) {
      if (edge.typeOnly) continue
      imports.push({ from: path, specifier: edge.specifier, line: edge.line, via: chainTo(path) })
      const target = host.resolve(path, edge.specifier)
      if (target === null || parent.has(target)) continue
      parent.set(target, path)
      queue.push(target)
    }
  }
  return { files: [...parent.keys()].sort(), imports, chainTo }
}

/**
 * Resolve a relative specifier to a file that exists, the way a bundler does
 * for this repo's sources: a .js specifier names the .ts file beside it, a bare one tries both
 * extensions and then an index file.
 */
export function resolveRelativeSource(
  fromPath: string,
  specifier: string,
  exists: (path: string) => boolean,
): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
  const resolved = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  const candidates =
    resolved.endsWith('.js') || resolved.endsWith('.jsx')
      ? [
          `${resolved.slice(0, resolved.lastIndexOf('.'))}.ts`,
          `${resolved.slice(0, resolved.lastIndexOf('.'))}.tsx`,
        ]
      : [`${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`, `${resolved}/index.tsx`]
  return candidates.find(exists) ?? null
}
