import { posix } from 'node:path'
import { scanSourceForBoundaryViolations } from './scanner.js'
import { resolveRelativeSource, walkValueImportClosure } from './value-import-closure.js'

/**
 * What stops a file from leaving Node when its VALUE imports are followed all
 * the way down, not only its own.
 *
 * `route-portability.test.ts` first judged a route by its own specifiers, and a
 * `node:fs` planted in `validators.ts` — which three "portable" routes import —
 * left it green. The routes read as portable because the Node arrives through
 * a helper they call. This walks the transitive closure (type-only edges are
 * erased at emit and not followed) and names each blocker, so a route's ledger
 * entry says WHICH seam or builtin holds it, not merely that it is held.
 *
 * Filesystem-free like `value-import-closure.ts`: the caller supplies the
 * files, so a fixture graph can stand in for the tree.
 */
export interface BlockerContext {
  /** Every source file the walk may enter, repo-relative path to text. */
  readonly files: ReadonlyMap<string, string>
  /** Repo-relative directory blocker names are shown under, with a trailing `/`. */
  readonly root: string
  /**
   * Files the walk does NOT enter, reported as `seam <name>`. A seam is a module
   * that is Node-bound itself and that a lift would replace with a handed-in
   * dependency; cutting it is what lets the rest of a route's closure speak.
   */
  readonly seams: ReadonlySet<string>
  /** A relative specifier naming one of this root's own mechanics. */
  readonly isMechanicSpecifier: (specifier: string) => boolean
  readonly isNodeOnlyPackage: (specifier: string) => boolean
}

const shown = (ctx: BlockerContext, path: string): string =>
  path.startsWith(ctx.root) ? path.slice(ctx.root.length) : path

/**
 * Every reason `entry` cannot leave Node, sorted: `seam <file>` for a cut seam
 * it reaches, `mechanic <file>` for one of this root's mechanics, and
 * `<what> in <file>` for a Node builtin, ambient global or Node-only package
 * somewhere in the closure. Empty when the closure is clean.
 */
export function blockersOf(entry: string, ctx: BlockerContext): string[] {
  const blockers = new Set<string>()
  const exists = (path: string): boolean => ctx.files.has(path)

  const closure = walkValueImportClosure([entry], {
    read: (path) => ctx.files.get(path) as string,
    resolve: (from, specifier) => {
      const target = resolveRelativeSource(from, specifier, exists)
      if (ctx.isMechanicSpecifier(specifier)) {
        const named = target ?? posix.normalize(posix.join(posix.dirname(from), specifier))
        blockers.add(`mechanic ${shown(ctx, named)}`)
        return null
      }
      if (target !== null && ctx.seams.has(target)) {
        blockers.add(`seam ${shown(ctx, target)}`)
        return null
      }
      return target
    },
  })

  for (const path of closure.files) {
    for (const { kind, name } of scanSourceForBoundaryViolations(path, ctx.files.get(path) ?? '')) {
      // loro-crdt is shared-layer by design and runs on every runtime.
      if (kind !== 'loro-crdt-import') blockers.add(`${name} in ${shown(ctx, path)}`)
    }
  }
  for (const { from, specifier } of closure.imports) {
    if (ctx.isNodeOnlyPackage(specifier)) blockers.add(`${specifier} in ${shown(ctx, from)}`)
  }
  return [...blockers].sort()
}
