/**
 * Loops among DIRECTORIES, which a layer order cannot see: two directories of
 * one layer may import each other freely as far as the order is concerned, and
 * `cycle-check` is file-level, so the loop closes through different files in
 * each direction and no file ever cycles. The layer guards share this one
 * computation (`server-core-layer-order`, `mcp-server-layer-order`,
 * `web-layer-order`) rather than each carrying a copy that can drift.
 */
import { collectRelativeImportEdges } from './cycle-check.js'
import { resolveRelativeSource } from './value-import-closure.js'

export interface SourceFile {
  /** Relative to the package's `src/`, `/`-separated. */
  readonly path: string
  readonly text: string
}

export interface ImportEdge {
  readonly from: string
  readonly to: string
  readonly typeOnly: boolean
}

/** Every relative import between `files` that resolves to one of them, type-only edges included. */
export function resolvedImportEdges(files: readonly SourceFile[]): readonly ImportEdge[] {
  const known = new Set(files.map(({ path }) => path))
  return files.flatMap(({ path, text }) =>
    collectRelativeImportEdges(path, text).flatMap(({ specifier, typeOnly }) => {
      const target = resolveRelativeSource(path, specifier, (candidate) => known.has(candidate))
      return target === null ? [] : [{ from: path, to: target, typeOnly }]
    }),
  )
}

export interface DirectoryLoop {
  /** The directories that reach each other, sorted. */
  readonly members: readonly string[]
  /**
   * Distinct file-to-file imports that cross between two members, in either
   * direction — the number a ledger pins, since a loop that gains an edge has
   * got harder to cut.
   */
  readonly edges: number
}

/**
 * The strongly connected components of the directory graph that hold more than
 * one directory. `unitOf` names the directory a file belongs to, or `undefined`
 * for a file that is not one (a root file, or a directory outside the scan).
 */
export function directoryLoops(
  edges: readonly Pick<ImportEdge, 'from' | 'to'>[],
  unitOf: (path: string) => string | undefined,
): DirectoryLoop[] {
  const graph = new Map<string, Set<string>>()
  const crossings: { readonly a: string; readonly b: string; readonly key: string }[] = []
  for (const { from, to } of edges) {
    const [a, b] = [unitOf(from), unitOf(to)]
    if (a === undefined || b === undefined) continue
    if (!graph.has(a)) graph.set(a, new Set())
    if (!graph.has(b)) graph.set(b, new Set())
    if (a === b) continue
    graph.get(a)?.add(b)
    crossings.push({ a, b, key: `${from} -> ${to}` })
  }
  const reaches = (start: string, goal: string, seen = new Set<string>()): boolean =>
    [...(graph.get(start) ?? [])].some((next) => {
      if (next === goal) return true
      if (seen.has(next)) return false
      seen.add(next)
      return reaches(next, goal, seen)
    })
  const looping = [...graph.keys()].filter((unit) => reaches(unit, unit))
  const components = new Map<string, readonly string[]>()
  for (const unit of looping) {
    const members = looping.filter((other) => reaches(unit, other) && reaches(other, unit)).sort()
    components.set(members.join(','), members)
  }
  return [...components.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, members]) => ({
      members,
      edges: new Set(
        crossings
          .filter(({ a, b }) => members.includes(a) && members.includes(b))
          .map((c) => c.key),
      ).size,
    }))
}

/** A loop spelled the way a ledger and a failure message name it. */
export const spellLoop = ({ members }: DirectoryLoop): string => members.join(',')
