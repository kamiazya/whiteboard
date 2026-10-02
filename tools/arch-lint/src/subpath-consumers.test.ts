/**
 * A package may be a legal dependency while one of its entries is not.
 *
 * The direction and allowed-dependency checks judge the PACKAGE, so
 * `canvas-render` importing `plugin-visual/ui` (React) or `facet-engine/testing`
 * (fast-check, a devDependency) passed every guard: both packages are allowed
 * to it. `no-test-utils-in-production` matches a `test-utils` path segment and
 * `/testing` is not one. The only thing left to notice was a built bundle.
 *
 * `SUBPATH_POLICY` records, per such subpath, which workspaces' shipped source
 * may load it. This test reads every manifest's `exports` so a NEW entry with
 * a test-only name or a `.tsx` target has to be declared rather than left to
 * whoever remembers, and holds the table from both sides.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUBPATH_POLICY } from './architecture-map.js'
import {
  isExcludedPath,
  REPO_ROOT,
  relativeToRepo,
  SCAN_ROOTS,
  workspaceDirs,
} from './scan-roots.js'
import { walkSourceFiles } from './source-scan.js'
import {
  findSubpathConsumerViolations,
  isShippedSourcePath,
  type SubpathScanFile,
  subpathConsumers,
  workspaceOf,
} from './subpath-consumer-check.js'

const PLANT_REACT = "import '@kamiazya/whiteboard-plugin-visual/ui'\nexport {}\n"
const PLANT_TESTING = "import '@kamiazya/whiteboard-facet-engine/testing'\nexport {}\n"

describe('what a subpath policy refuses, on fixture files', () => {
  const check = (path: string, text: string): string[] =>
    findSubpathConsumerViolations([{ path, text }], SUBPATH_POLICY)

  it('refuses a React entry from a package that is not a React consumer', () => {
    expect(check('packages/canvas-render/src/zz-a.ts', PLANT_REACT)).toEqual([
      'packages/canvas-render/src/zz-a.ts imports @kamiazya/whiteboard-plugin-visual/ui (allowed from: apps/web)',
    ])
  })

  it('refuses a test-only entry from any shipped file, naming it', () => {
    expect(check('packages/canvas-render/src/zz-b.ts', PLANT_TESTING)).toEqual([
      'packages/canvas-render/src/zz-b.ts imports @kamiazya/whiteboard-facet-engine/testing (allowed from: tests only)',
    ])
    expect(check('apps/web/src/zz.ts', PLANT_TESTING)).toHaveLength(1)
  })

  it('refuses a dynamic import and a re-export the same way', () => {
    const dynamic = [
      'export const l = () => ',
      "import('@kamiazya/whiteboard-facet-engine/testing')",
    ].join('')
    expect(check('packages/codec/src/zz.ts', dynamic)).toHaveLength(1)
    expect(
      check(
        'packages/codec/src/zz.ts',
        "export * from '@kamiazya/whiteboard-facet-engine/testing'\n",
      ),
    ).toHaveLength(1)
  })

  it('lets a named consumer load the entry it is named for', () => {
    expect(check('apps/web/src/zz.tsx', PLANT_REACT)).toEqual([])
  })

  it('does not take the package root, or a sibling entry, for the policed one', () => {
    expect(
      check(
        'packages/canvas-render/src/zz.ts',
        "import '@kamiazya/whiteboard-plugin-visual'\nimport '@kamiazya/whiteboard-plugin-visual/render'\nimport '@kamiazya/whiteboard-facet-engine'\n",
      ),
    ).toEqual([])
  })
})

describe('what counts as shipped source', () => {
  it.each([
    ['packages/a/src/x.ts', true],
    ['apps/web/src/pages/P.tsx', true],
    ['packages/a/src/x.test.ts', false],
    ['packages/a/src/x.bench.ts', false],
    ['packages/a/src/_test-harness.ts', false],
    ['packages/a/src/test-utils/x.ts', false],
    ['packages/facet-engine/src/testing/x.ts', false],
  ])('%s -> %s', (path, shipped) => {
    expect(isShippedSourcePath(path)).toBe(shipped)
  })
})

interface Manifest {
  readonly name: string
  readonly exports?: Readonly<Record<string, string | { readonly import?: string }>>
}

function manifests(): Manifest[] {
  return workspaceDirs().map(
    (dir) => JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')) as Manifest,
  )
}

/** Every `<package>/<subpath>` specifier a manifest publishes, with its target. */
function publishedSubpaths(): { specifier: string; target: string }[] {
  return manifests().flatMap(({ name, exports }) =>
    Object.entries(exports ?? {})
      .filter(([key]) => key !== '.' && key !== './package.json')
      .map(([key, value]) => ({
        specifier: `${name}${key.slice(1)}`,
        target: typeof value === 'string' ? value : (value.import ?? ''),
      })),
  )
}

const TEST_ONLY_NAME = /(?:^|\/)(?:testing|test-utils)(?:\/|$)|\.test-helper$/

const shipped: SubpathScanFile[] = SCAN_ROOTS.flatMap((root) =>
  walkSourceFiles(join(REPO_ROOT, root))
    .filter((path) => !isExcludedPath(path))
    .map((path) => ({ path: relativeToRepo(path), text: readFileSync(path, 'utf8') }))
    .filter(({ path }) => isShippedSourcePath(path)),
)

describe('shipped source loads only the subpaths its workspace is named for', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule.
    expect(shipped.length).toBeGreaterThan(800)
    expect(new Set(shipped.map(({ path }) => workspaceOf(path))).size).toBeGreaterThan(10)
  })

  it('finds no shipped import of a subpath outside its consumers', () => {
    expect(findSubpathConsumerViolations(shipped, SUBPATH_POLICY)).toEqual([])
  })

  it('reaches its subject: a named consumer really does load the React entry', () => {
    const consumers = subpathConsumers(shipped, SUBPATH_POLICY)
    expect([...(consumers.get('@kamiazya/whiteboard-plugin-visual/ui') ?? [])]).toEqual([
      'apps/web',
    ])
  })

  it('names no consumer that has stopped importing its subpath', () => {
    const consumers = subpathConsumers(shipped, SUBPATH_POLICY)
    const stale = Object.entries(SUBPATH_POLICY).flatMap(([specifier, { consumers: allowed }]) =>
      allowed
        .filter((workspace) => !consumers.get(specifier)?.has(workspace))
        .map((workspace) => `${specifier}: ${workspace}`),
    )
    expect(stale, 'an allowed consumer that imports nothing is a permission nobody uses').toEqual(
      [],
    )
  })
})

describe('the policy table agrees with the manifests', () => {
  const published = publishedSubpaths()

  it('reads the manifests', () => {
    expect(published.length).toBeGreaterThan(50)
  })

  it('names only subpaths a manifest publishes', () => {
    const real = new Set(published.map(({ specifier }) => specifier))
    expect(Object.keys(SUBPATH_POLICY).filter((specifier) => !real.has(specifier))).toEqual([])
  })

  it('declares every published subpath that is named for tests or targets a .tsx file', () => {
    const undeclared = published
      .filter(({ specifier, target }) => TEST_ONLY_NAME.test(specifier) || target.endsWith('.tsx'))
      .map(({ specifier }) => specifier)
      .filter((specifier) => !(specifier in SUBPATH_POLICY))
    expect(
      undeclared,
      'add it to SUBPATH_POLICY in architecture-map.ts with who may load it from shipped source',
    ).toEqual([])
  })

  it('gives every entry a reason and a workspace that exists', () => {
    const dirs = new Set(workspaceDirs())
    for (const [specifier, { consumers, reason }] of Object.entries(SUBPATH_POLICY)) {
      expect(reason.split(/\s+/).length, `${specifier} needs a reason`).toBeGreaterThan(8)
      for (const workspace of consumers) {
        expect(dirs.has(workspace), `${specifier}: ${workspace} is no workspace`).toBe(true)
      }
    }
  })
})
