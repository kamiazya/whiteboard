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

/** `.`, `..`, `./x`, `../x` — every spelling of a path relative to the importing file. */
export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  )
}

/**
 * The files a resolved (extension-bearing or bare) path could name, the way a
 * bundler reads this repo's sources: a `.js`/`.jsx` specifier names the `.ts`/
 * `.tsx` beside it, an explicit `.ts`/`.tsx` names itself, and a bare one tries
 * both extensions and then an index file.
 */
export function sourceCandidates(resolved: string): string[] {
  if (resolved.endsWith('.js') || resolved.endsWith('.jsx')) {
    const base = resolved.slice(0, resolved.lastIndexOf('.'))
    return [`${base}.ts`, `${base}.tsx`]
  }
  if (resolved.endsWith('.ts') || resolved.endsWith('.tsx')) return [resolved]
  return [`${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`, `${resolved}/index.tsx`]
}

/**
 * Resolve a relative specifier to a file that exists. A trailing slash
 * (`from '../'`) is dropped first: `posix.normalize` keeps it, and the
 * candidates would then carry an empty file stem.
 */
export function resolveRelativeSource(
  fromPath: string,
  specifier: string,
  exists: (path: string) => boolean,
): string | null {
  if (!isRelativeSpecifier(specifier)) return null
  const resolved = posix
    .normalize(posix.join(posix.dirname(fromPath), specifier))
    .replace(/\/$/, '')
  return sourceCandidates(resolved).find(exists) ?? null
}

/** The part of a workspace manifest that decides which file a specifier loads. */
export interface WorkspaceManifest {
  /** Absolute directory of the package. */
  readonly dir: string
  readonly exports?: Readonly<Record<string, string | { readonly import?: string }>>
  readonly main?: string
}

function exportTarget(manifest: WorkspaceManifest, subpath: string): string | undefined {
  if (manifest.exports === undefined) return subpath === '.' ? manifest.main : undefined
  const entry = manifest.exports[subpath]
  return typeof entry === 'string' ? entry : entry?.import
}

/**
 * The source file `<package>` or `<package>/<subpath>` loads, read through the
 * package's own `exports` map the way the bundler reads it — never by guessing
 * a path from the name, because a subpath is exactly where a package decides
 * what a light import is.
 *
 * `null` for a specifier that is not a workspace package or that names a
 * non-source target (`./package.json`). A workspace package whose `exports`
 * does not name the subpath THROWS: answering `null` would end the walk at an
 * import the guard exists to follow, which reads as clean.
 */
export function resolveWorkspaceSource(
  specifier: string,
  packages: ReadonlyMap<string, WorkspaceManifest>,
): string | null {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string)
  const manifest = packages.get(name)
  if (manifest === undefined) return null
  const subpath = specifier.length === name.length ? '.' : `.${specifier.slice(name.length)}`
  const target = exportTarget(manifest, subpath)
  if (target === undefined)
    throw new Error(`${name} does not export '${subpath}' (from '${specifier}')`)
  return /\.tsx?$/.test(target) ? posix.join(manifest.dir, target) : null
}
