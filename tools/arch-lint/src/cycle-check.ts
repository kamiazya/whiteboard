// Circular-dependency check, built on scanner.ts's existing TypeScript-
// compiler-API traversal rather than a new dependency (madge et al.) — the
// repo's own simplicity ladder: reuse the AST walk that already exists.
//
// Scope, deliberately: relative (`./`, `../`) specifiers, plus any bare
// prefix a caller declares as a path ALIAS for an intra-package directory.
// Cross-package/workspace specifiers stay direction-check.ts's job, and
// every cycle this check exists to catch is intra-package — an alias is
// intra-package too, which is exactly why it has to participate: `apps/web`
// writes a fifth of its own imports as `@/...`, and a resolver blind to
// them answers "no cycles" from a graph missing a fifth of its edges.
// Filesystem-free by design (pure functions over supplied file contents) so
// unit tests can feed fixture graphs directly.

import { posix } from 'node:path'
import ts from 'typescript'
import { collectModuleSpecifiers } from './scanner.js'

export interface ImportEdge {
  readonly specifier: string
  readonly typeOnly: boolean
  readonly line: number
}

/**
 * A bare import prefix that stands for a directory inside the scanned tree,
 * mapped to that directory as a repo-relative path — e.g. `{'@/':
 * 'apps/web/src/'}` for `apps/web`'s tsconfig `paths` entry. Both sides keep
 * their trailing slash so the rewrite is a plain prefix swap.
 */
export type PathAliases = Readonly<Record<string, string>>

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

/** Relative-specifier subset of scanner.ts's module-specifier walk. */
export function collectRelativeImportEdges(fileName: string, sourceText: string): ImportEdge[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  return collectModuleSpecifiers(sourceFile).filter(({ specifier }) => isRelative(specifier))
}

/**
 * As {@link collectRelativeImportEdges}, but also keeping every specifier
 * that starts with a declared alias prefix. The alias is left UNEXPANDED
 * here; resolution turns it into a path, so this stays a pure filter.
 */
function collectResolvableImportEdges(
  fileName: string,
  sourceText: string,
  aliases: PathAliases,
): ImportEdge[] {
  const prefixes = Object.keys(aliases)
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  return collectModuleSpecifiers(sourceFile).filter(
    ({ specifier }) =>
      isRelative(specifier) || prefixes.some((prefix) => specifier.startsWith(prefix)),
  )
}

function candidatePaths(resolved: string): string[] {
  if (resolved.endsWith('.js') || resolved.endsWith('.jsx')) {
    const base = resolved.slice(0, resolved.lastIndexOf('.'))
    return [`${base}.ts`, `${base}.tsx`]
  }
  return [`${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`, `${resolved}/index.tsx`]
}

function resolveSpecifier(
  fromPath: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
  aliases: PathAliases,
): string | null {
  // An alias is already repo-relative once swapped, so it must NOT be joined
  // against the importing file's directory the way a `./` specifier is.
  const aliasPrefix = Object.keys(aliases).find((prefix) => specifier.startsWith(prefix))
  const resolved =
    aliasPrefix === undefined
      ? posix.normalize(posix.join(posix.dirname(fromPath), specifier))
      : posix.normalize(aliases[aliasPrefix] + specifier.slice(aliasPrefix.length))
  for (const candidate of candidatePaths(resolved)) {
    if (fileSet.has(candidate)) return candidate
  }
  return null
}

/**
 * Value-only (type-only edges dropped) relative-import graph. Every file
 * passed in is a key; an unresolvable or bare-specifier edge is dropped
 * rather than throwing, since resolution here is pure set-membership against
 * the supplied file list, not a real module resolver.
 */
export function buildValueImportGraph(
  files: readonly { path: string; text: string }[],
  aliases: PathAliases = {},
): Map<string, string[]> {
  const fileSet = new Set(files.map((f) => f.path))
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const targets: string[] = []
    for (const edge of collectResolvableImportEdges(file.path, file.text, aliases)) {
      if (edge.typeOnly) continue
      const resolved = resolveSpecifier(file.path, edge.specifier, fileSet, aliases)
      if (resolved !== null) targets.push(resolved)
    }
    graph.set(file.path, targets)
  }
  return graph
}

/**
 * Tarjan SCC over the value-import graph, returning every strongly-connected
 * component of size > 1 plus any self-loop. Each group, and the list of
 * groups, is sorted — determinism a path-keyed allowlist (architecture-map.ts's
 * `KNOWN_IMPORT_CYCLES`) depends on: an unsorted result would flap between
 * runs as input file order (readdir, etc.) varies.
 */
export function findImportCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result: string[][] = []
  let nextIndex = 0

  function strongConnect(v: string): void {
    indices.set(v, nextIndex)
    lowlink.set(v, nextIndex)
    nextIndex += 1
    stack.push(v)
    onStack.add(v)

    for (const w of graph.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w)
        lowlink.set(v, Math.min(lowlink.get(v) as number, lowlink.get(w) as number))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) as number, indices.get(w) as number))
      }
    }

    if (lowlink.get(v) !== indices.get(v)) return
    const component: string[] = []
    let w: string
    do {
      w = stack.pop() as string
      onStack.delete(w)
      component.push(w)
    } while (w !== v)
    const isSelfLoop =
      component.length === 1 &&
      (graph.get(component[0] as string) ?? []).includes(component[0] as string)
    if (component.length > 1 || isSelfLoop) {
      result.push(component.sort())
    }
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) strongConnect(node)
  }

  return result.sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1))
}
