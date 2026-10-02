import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOUNDARY_SCAN_PACKAGES, listTsFiles } from './scan-packages.js'
import { REPO_ROOT, relativeToRepo } from './scan-roots.js'
import { findSourceDirectionViolations } from './source-direction-check.js'
import { isTestPath } from './source-scan.js'

/**
 * Files in a boundary-scanned package that import a workspace package the map
 * does not allow it, keyed by repo-relative path, each with why. Guarded from
 * both sides below, so an entry cannot outlive the edge it records.
 */
const SOURCE_DIRECTION_EXEMPT: Readonly<Record<string, string>> = {
  'packages/facet-engine/src/testing/facet-arbitraries.ts':
    "the package's `./testing` entry: fast-check generators built over model's test-utils, imported only by test files and kept out of the default entry, so the engine's runtime graph never gains the edge; model is a devDependency for that reason",
}

const NAME_OF: Readonly<Record<string, string>> = Object.fromEntries(
  BOUNDARY_SCAN_PACKAGES.map((dir) => [
    dir,
    (JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')) as { name: string })
      .name,
  ]),
)

const productionFiles = (dir: string): string[] =>
  listTsFiles(join(REPO_ROOT, dir, 'src'), ['.ts', '.tsx']).filter((file) => !isTestPath(file))

describe('source imports of workspace packages follow the map, not just the manifest', () => {
  const violationsIn = (name: string, source: string): string[] =>
    findSourceDirectionViolations(name, 'x.ts', source).map(({ specifier }) => specifier)

  it('reports an import of a workspace package the map does not allow, in every import form', () => {
    const search = '@kamiazya/whiteboard-search'
    expect(violationsIn(search, "import { a } from '@kamiazya/whiteboard-codec'")).toEqual([
      '@kamiazya/whiteboard-codec',
    ])
    expect(violationsIn(search, "export * from '@kamiazya/whiteboard-codec/okf'")).toEqual([
      '@kamiazya/whiteboard-codec/okf',
    ])
    const dynamic = ['const m = await ', "import('@kamiazya/whiteboard-codec')"].join('')
    expect(violationsIn(search, dynamic)).toEqual(['@kamiazya/whiteboard-codec'])
  })

  it('allows what the map allows, the package itself and anything third-party', () => {
    const search = '@kamiazya/whiteboard-search'
    expect(violationsIn(search, "import { a } from '@kamiazya/whiteboard-model'")).toEqual([])
    expect(violationsIn(search, "import { a } from '@kamiazya/whiteboard-search/x'")).toEqual([])
    expect(violationsIn(search, "import { a } from 'zod'")).toEqual([])
    expect(violationsIn(search, "// import { a } from '@kamiazya/whiteboard-codec'")).toEqual([])
  })

  it('does not read a longer package name as a prefix of a shorter one', () => {
    // `whiteboard-mcp` must not be matched by a `whiteboard-model` specifier or the reverse.
    expect(
      violationsIn('@kamiazya/whiteboard-codec', "import 'x' // @kamiazya/whiteboard-model"),
    ).toEqual([])
  })

  it('reads every boundary-scanned package', () => {
    // An empty walk agrees with every rule; a package that yields no file reads as a clean one.
    expect(BOUNDARY_SCAN_PACKAGES.filter((dir) => productionFiles(dir).length === 0)).toEqual([])
    expect(BOUNDARY_SCAN_PACKAGES.flatMap(productionFiles).length).toBeGreaterThan(300)
  })

  const violations = BOUNDARY_SCAN_PACKAGES.flatMap((dir) =>
    productionFiles(dir).flatMap((file) => {
      const found = findSourceDirectionViolations(
        NAME_OF[dir] as string,
        file,
        readFileSync(file, 'utf8'),
      )
      return found.map((v) => ({ file: relativeToRepo(file), ...v }))
    }),
  )

  it('no production file imports a workspace package outside its map entry', () => {
    const unlisted = violations
      .filter(({ file }) => !(file in SOURCE_DIRECTION_EXEMPT))
      .map(({ file, specifier, line }) => `${file}:${line} imports ${specifier}`)
    expect(
      unlisted,
      "the importing package's `allowedInternalDeps` does not name it. A devDependency resolves for tsc and ships nothing to a manifest check, but the import is a runtime edge.",
    ).toEqual([])
  })

  it('every exemption names a file that still holds a disallowed import, with a reason', () => {
    const held = new Set(violations.map(({ file }) => file))
    for (const [file, reason] of Object.entries(SOURCE_DIRECTION_EXEMPT)) {
      expect(held.has(file), `${file} imports nothing disallowed any more`).toBe(true)
      expect(reason.split(/\s+/).length, `${file}'s reason is too short`).toBeGreaterThan(8)
    }
  })
})
