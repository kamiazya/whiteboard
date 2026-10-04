/**
 * Where a name imported from a module is DECLARED, read from the export
 * tables of the files a scan holds rather than from the name alone.
 *
 * Two exports can share a name (`LEDGER`, `WORKSPACE_TREE_KEY`), and a scan
 * that judges a use by the spelling alone lets a use of one excuse the other.
 * A use binds to a declaration through the module specifier it was imported
 * from and the name it was imported under, followed through `export { x } from`
 * and `export *` barrels to the file that declares it.
 */

/** What one module offers to an importer. */
export interface ModuleExports {
  /** Names the module declares and exports itself. */
  readonly declared: ReadonlySet<string>
  /** `export { imported as name } from spec`, and `export { x }` of an imported `x`. */
  readonly forwarded: ReadonlyMap<string, { readonly spec: string; readonly imported: string }>
  /** `export * from spec`. */
  readonly stars: readonly string[]
}

/**
 * - an object: the declaration the name binds to.
 * - `elsewhere`: the import leaves the scanned files (a third-party package) or
 *   names something the module does not export, so it binds to no declaration here.
 * - `unknown`: the specifier or a link of the chain could not be resolved, so
 *   the name is all there is to go on.
 */
export type Resolution = { readonly path: string; readonly name: string } | 'elsewhere' | 'unknown'

/** Every workspace package is published under this scope, so a specifier carrying it is ours even when no entry names it. */
const WORKSPACE_SCOPE = '@kamiazya/whiteboard'

const SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs']
const BUILT_SUFFIX = /\.(?:js|mjs|cjs|jsx)$/

/** `from`'s directory joined with a relative `spec`, with `.` and `..` folded away. */
function joinRelative(from: string, spec: string): string {
  const parts = from.split('/').slice(0, -1)
  for (const part of spec.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/')
}

/** The files a relative specifier can name: as written, its source twin, with a suffix, or as a directory. */
function relativeCandidates(base: string): string[] {
  const stem = base.replace(BUILT_SUFFIX, '')
  return [
    base,
    ...(stem === base ? [] : ['.ts', '.tsx', '.mts'].map((suffix) => stem + suffix)),
    ...SOURCE_SUFFIXES.map((suffix) => base + suffix),
    ...SOURCE_SUFFIXES.map((suffix) => `${base}/index${suffix}`),
  ]
}

interface Scan {
  readonly modules: ReadonlyMap<string, ModuleExports>
  readonly entries: ReadonlyMap<string, string>
}

/** A scanned file is wrapped so a path cannot be mistaken for the two verdict words. */
type ModuleLookup = { readonly path: string } | 'elsewhere' | 'unknown'

function moduleOf(scan: Scan, from: string, spec: string): ModuleLookup {
  if (spec.startsWith('.')) {
    const path = relativeCandidates(joinRelative(from, spec)).find((c) => scan.modules.has(c))
    return path === undefined ? 'unknown' : { path }
  }
  const entry = scan.entries.get(spec)
  if (entry !== undefined) return scan.modules.has(entry) ? { path: entry } : 'unknown'
  return spec.startsWith(WORKSPACE_SCOPE) ? 'unknown' : 'elsewhere'
}

function through(
  scan: Scan,
  from: string,
  spec: string,
  name: string,
  seen: Set<string>,
): Resolution {
  const target = moduleOf(scan, from, spec)
  return typeof target === 'string' ? target : follow(scan, target.path, name, seen)
}

function followStars(
  scan: Scan,
  path: string,
  stars: readonly string[],
  name: string,
  seen: Set<string>,
): Resolution {
  let unresolved = false
  for (const spec of stars) {
    const found = through(scan, path, spec, name, seen)
    if (typeof found === 'object') return found
    if (found === 'unknown') unresolved = true
  }
  return unresolved ? 'unknown' : 'elsewhere'
}

function follow(scan: Scan, path: string, name: string, seen: Set<string>): Resolution {
  const key = `${path}\u0000${name}`
  const exports = scan.modules.get(path)
  if (exports === undefined || seen.has(key)) return 'unknown'
  seen.add(key)
  if (exports.declared.has(name)) return { path, name }
  const forwarded = exports.forwarded.get(name)
  if (forwarded !== undefined) return through(scan, path, forwarded.spec, forwarded.imported, seen)
  return followStars(scan, path, exports.stars, name, seen)
}

/**
 * A resolver over `modules`. `entries` maps a workspace package specifier
 * (`@scope/pkg`, `@scope/pkg/sub`) to the file its export map names, since a
 * source file alone does not say where a package specifier lands.
 *
 * A workspace specifier with no entry, and a relative one that names no
 * scanned file, are `unknown` rather than `elsewhere`: a resolver that is
 * wrong about those must lean toward counting the use, never dropping it.
 */
export function createExportResolver(
  modules: ReadonlyMap<string, ModuleExports>,
  entries: ReadonlyMap<string, string>,
): (from: string, spec: string | undefined, name: string) => Resolution {
  const scan: Scan = { modules, entries }
  const memo = new Map<string, Resolution>()
  return (from, spec, name) => {
    if (spec === undefined) return 'unknown'
    const key = `${from}\u0000${spec}\u0000${name}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    const resolved = through(scan, from, spec, name, new Set())
    memo.set(key, resolved)
    return resolved
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The file an export-map target names: a bare string, or the `import` condition of an object. */
function exportTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target
  return isRecord(target) && typeof target.import === 'string' ? target.import : undefined
}

/**
 * Where each workspace package specifier lands, read from the `exports` of the
 * package manifests: `@scope/pkg` for `.`, `@scope/pkg/sub` for `./sub`. A
 * target outside `src` (a built entry) and a pattern (`./x/*`) name no scanned
 * file, so they are left out and resolve as `unknown`.
 */
export function workspaceEntries(
  manifests: readonly { readonly dir: string; readonly text: string }[],
): Map<string, string> {
  const entries = new Map<string, string>()
  for (const { dir, text } of manifests) {
    const manifest: unknown = JSON.parse(text)
    if (!isRecord(manifest) || typeof manifest.name !== 'string') continue
    const exportMap = isRecord(manifest.exports) ? manifest.exports : {}
    for (const [key, value] of Object.entries(exportMap)) {
      const target = exportTarget(value)
      if (target === undefined || key.includes('*') || !target.startsWith('./src/')) continue
      entries.set(`${manifest.name}${key === '.' ? '' : key.slice(1)}`, `${dir}/${target.slice(2)}`)
    }
  }
  return entries
}
