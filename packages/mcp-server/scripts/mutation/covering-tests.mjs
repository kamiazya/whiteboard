// Which test files can reach a mutated module, read from the source's import
// graph rather than listed: a list of covering tests goes stale the day a test
// starts importing a mutated module, and the lane then reports a survivor for
// a mutant a test would have killed.
//
// A test is selected when a chain of at most `COVERING_DEPTH` imports leads
// from it to a mutated module: the module's own tests, and the tests of the
// modules that consume it. The graph follows every import, executed or not, so
// within that depth it selects a superset of what Stryker's per-test coverage
// would record. Past it the chain runs through the app and daemon boot, where
// every test imports the app: unbounded, the closure is 204 of 458 test files
// and 70% of their runtime, and the initial run Stryker bounds and aborts on
// any failure in grows to the whole integration suite. ponytail: a depth cap;
// if a survivor is found that only a deeper test kills, raise it.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import config from '../../stryker.config.mjs'

/** Imports between a test and a mutated module: 1 is a direct import, 2 goes through one module. */
const COVERING_DEPTH = 2

const PACKAGE_DIR = resolve(import.meta.dirname, '../..')
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts']

// Module specifiers only: `from '..'`, a side-effect or dynamic `import`, and
// the calls that load a module by path (`vi.mock`, `importActual`, `require`).
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\b(?:mock|doMock|importActual|require)\s*\(\s*)['"](\.{1,2}\/[^'"]+|\.{1,2})['"]/g

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [path] : []
  })
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The source file a specifier names, or undefined when it leaves `src` or names a non-source file. */
function resolveSpecifier(fromFile, specifier, files) {
  const base = resolve(dirname(fromFile), specifier)
  // `./x.js` names `./x.ts`: the build emits the extension the source never has.
  const stem = base.replace(/\.(?:m|c)?jsx?$/, '')
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${stem}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ]
  return candidates.find((candidate) => files.has(candidate) && isFile(candidate))
}

/** Each source file's importers, over the files in `src`. */
function importersOf(files) {
  const importers = new Map()
  for (const file of files) {
    for (const [, specifier] of readFileSync(file, 'utf-8').matchAll(SPECIFIER)) {
      const target = resolveSpecifier(file, specifier, files)
      if (target !== undefined) importers.set(target, [...(importers.get(target) ?? []), file])
    }
  }
  return importers
}

/**
 * Every test file under `src` that imports one of `mutated` (paths relative to
 * the package) within `depth` imports, as package-relative POSIX paths, sorted.
 */
export function coveringTests(
  mutated = config.mutate,
  packageDir = PACKAGE_DIR,
  depth = COVERING_DEPTH,
) {
  const importers = importersOf(new Set(sourceFiles(join(packageDir, 'src'))))
  const reached = new Set(mutated.map((path) => resolve(packageDir, path)))
  let frontier = [...reached]
  for (let level = 0; level < depth; level++) {
    frontier = frontier
      .flatMap((file) => importers.get(file) ?? [])
      .filter((importer) => !reached.has(importer))
    for (const file of frontier) reached.add(file)
  }
  return [...reached]
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => relative(packageDir, file).split(sep).join('/'))
    .sort()
}
