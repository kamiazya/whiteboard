/**
 * A relative import never leaves its workspace, and the ones no resolver can
 * follow are a known set.
 *
 * Every other boundary guard reads MANIFESTS (direction, allowed dependencies,
 * package cycles) or one named pair of trees (`web-app-boundary.test.ts`). A
 * relative specifier walks straight past all of them: `export * from
 * '../../codec/src/index.js'` in `model` is an upward edge and a package cycle,
 * and planted it left the whole project green and `tsc` in `model` passing —
 * `tsc` resolves it happily. It is the one door that bypasses the manifest
 * model, and the path a "quick" cross-package import or a retired alias walks
 * through.
 *
 * It scans every workspace's `src` over `packages/*`, `apps/*` and `tools/*`,
 * tests and `test-utils` included: a test that reaches into another package's
 * source is the same coupling, and the ledger below says which ones do on
 * purpose.
 *
 * The second half is the cycle scan's own blind spot. `cycle-check.ts` resolves
 * specifiers against TypeScript files and drops what it cannot resolve, which
 * reads as "no edge". The edges it drops from SHIPPED source are assets (a
 * stylesheet, an SVG component, a font URL, a JSON file), and a known set is
 * what keeps a dropped edge from being a real module the graph never saw.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectRelativeImportEdges } from './cycle-check.js'
import { REPO_ROOT, relativeToRepo, walk, workspaceDirs } from './scan-roots.js'
import { isShippedPath } from './source-scan.js'
import { resolveRelativeSource, sourceCandidates } from './value-import-closure.js'

/**
 * Relative imports that deliberately leave their workspace, each as
 * `<importing file> -> <repo-relative target, as written>` with why.
 *
 * Every one is a TEST reading something outside its package: no shipped file
 * may. Guarded from both sides below — an entry that is no longer an escaping
 * edge fails, so the list cannot go on excusing an import that was fixed.
 */
const ESCAPES: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/server/release/publish-dry-run-policy.test.ts -> tools/arch-lint/src/job-section.js':
    'a release-policy test that reads one workflow job through the arch-lint helper; the daemon-side twin of a guard that could not move (tool-arch-lint.md, "Repo-policy guards live here")',
  'packages/mcp-server/src/server/release/publish-production-policy.test.ts -> tools/arch-lint/src/job-section.js':
    'a release-policy test that reads one workflow job through the arch-lint helper; the daemon-side twin of a guard that could not move (tool-arch-lint.md, "Repo-policy guards live here")',
  'packages/mcp-server/src/server/release/sbom-policy.test.ts -> tools/arch-lint/src/job-section.js':
    'a release-policy test that reads one workflow job through the arch-lint helper; the daemon-side twin of a guard that could not move (tool-arch-lint.md, "Repo-policy guards live here")',
  'apps/web/src/vitest-project-name.test.ts -> package.json':
    'asserts the root manifest and the web vitest project agree on a project name, so it has to read the root `package.json`',
  'tools/arch-lint/src/browser-launch-options.test.ts -> vitest.browser.launch-options.js':
    'arch-lint polices the root vitest browser config, so it imports the module it is policing',
  'tools/arch-lint/src/vitest-projects.test.ts -> vitest.browser.shared.js':
    'arch-lint polices the root vitest project list, so it imports the module it is policing',
}

/**
 * Relative imports in SHIPPED source that resolve to no TypeScript file, each
 * as `<importing file> -> <specifier as written>`, with the asset it names.
 *
 * `cycle-check.ts` drops each of these from its graph. They are the whole of
 * what it drops, and the guard below keeps them that: an import that stops
 * resolving to a file at all fails as dangling, and a new dropped edge fails
 * as unlisted until someone says what it is.
 */
const UNRESOLVED_IN_SHIPPED_SOURCE: Readonly<Record<string, string>> = {
  'packages/canvas-viewer/src/font-embedding.ts -> ../assets/fonts/Roboto/Roboto-Regular.ttf?url':
    'a Vite `?url` import of a font binary — an asset URL, not a module',
  'packages/canvas-viewer/src/font-loading.ts -> ../assets/fonts/Roboto/Roboto-Regular.ttf?url':
    'a Vite `?url` import of a font binary — an asset URL, not a module',
  'apps/web/src/components/SquiggleLoader.tsx -> ../brand/loader-mark.svg?react':
    'an SVGR `?react` import: the component is generated from the .svg beside it',
  'apps/web/src/components/status/ErrorFallback.tsx -> ../../brand/error-mark.svg?react':
    'an SVGR `?react` import: the component is generated from the .svg beside it',
  'apps/web/src/components/status/NotFoundPage.tsx -> ../../brand/not-found-mark.svg?react':
    'an SVGR `?react` import: the component is generated from the .svg beside it',
  'apps/web/src/components/workspace-files/EmptyWorkspaceState.tsx -> ../../brand/welcome-mark.svg?react':
    'an SVGR `?react` import: the component is generated from the .svg beside it',
  'apps/web/src/lib/webmcp/tool-definitions.ts -> ./tool-result-schemas/get-app-context.schema.json':
    'a JSON schema file imported as data',
  'apps/extension/src/manifest.ts -> ../package.json':
    'the extension package version, imported as data so the manifest stamps the one declared version',
  'apps/web/src/main.tsx -> ./index.css': 'the global stylesheet, a side-effect import',
}

interface RelativeEdge {
  /** Repo-relative path of the importing file. */
  readonly from: string
  readonly workspace: string
  readonly specifier: string
  /** Repo-relative target with any `?query` removed and a trailing slash dropped. */
  readonly target: string
}

const isSourceFile = (file: string): boolean => /\.(ts|tsx)$/.test(file)

/** Every `.ts`/`.tsx` under every workspace's `src`, repo-relative. */
const FILES: readonly { readonly path: string; readonly workspace: string }[] = workspaceDirs()
  .filter((dir) => existsSync(join(REPO_ROOT, dir, 'src')))
  .flatMap((workspace) =>
    walk(join(REPO_ROOT, workspace, 'src'), {
      include: isSourceFile,
      skip: (_full, name) => name === 'node_modules' || name === 'dist',
    }).map((full) => ({ path: relativeToRepo(full), workspace })),
  )

const FILE_SET: ReadonlySet<string> = new Set(FILES.map(({ path }) => path))

const EDGES: readonly RelativeEdge[] = FILES.flatMap(({ path, workspace }) =>
  collectRelativeImportEdges(path, readFileSync(join(REPO_ROOT, path), 'utf8')).map(
    ({ specifier }) => ({
      from: path,
      workspace,
      specifier,
      target: posix
        .normalize(posix.join(posix.dirname(path), specifier.replace(/\?.*$/, '')))
        .replace(/\/$/, ''),
    }),
  ),
)

const insideWorkspace = ({ workspace, target }: RelativeEdge): boolean =>
  target === workspace || target.startsWith(`${workspace}/`)

/** Test, support, bench and harness files do not ship, so a deliberate reach out of the workspace there is not a defect. */
const isShipped = isShippedPath

const edgeKey = (edge: RelativeEdge): string => `${edge.from} -> ${edge.target}`

const escaping = EDGES.filter((edge) => !insideWorkspace(edge))

const dropped = EDGES.filter(
  (edge) => resolveRelativeSource(edge.from, edge.specifier, (path) => FILE_SET.has(path)) === null,
)

describe('a relative import never leaves its workspace', () => {
  it('reads the workspaces and the relative edges it exists to judge', () => {
    // A walk that found nothing would pass every assertion below.
    expect(workspaceDirs().length, 'the workspace walk found almost nothing').toBeGreaterThan(15)
    expect(FILES.length, 'the source walk found almost nothing').toBeGreaterThan(2000)
    expect(EDGES.length, 'the import walk found almost nothing').toBeGreaterThan(5000)
  })

  it('has no shipped file that imports outside its workspace', () => {
    expect(
      escaping.filter(({ from }) => isShipped(from)).map(edgeKey),
      'a non-test file reaches into another workspace by relative path, which no manifest check sees. ' +
        'Depend on the package through its name and `exports` instead.',
    ).toEqual([])
  })

  it('lists every test that imports outside its workspace, with a reason', () => {
    const unlisted = escaping.map(edgeKey).filter((key) => ESCAPES[key] === undefined)
    expect(
      unlisted,
      'a relative import leaves its workspace. If it is a test that has to read the root or ' +
        'another tool, add it to ESCAPES with the reason; otherwise import the package by name.',
    ).toEqual([])
  })

  it('keeps every ESCAPES entry a real escaping edge with a reason of substance', () => {
    const real = new Set(escaping.map(edgeKey))
    const stale = Object.entries(ESCAPES)
      .filter(([key, reason]) => !real.has(key) || reason.trim().length <= 20)
      .map(([key]) => key)
    expect(stale, 'drop the entry, or give it a reason').toEqual([])
  })
})

describe('the relative edges no resolver can follow are a known set', () => {
  it('has no relative import that names nothing at all', () => {
    // Anything dropped must at least be a real file (an asset): a dangling path
    // is a broken import that a `?raw` or `?url` query would hide from `tsc`.
    const onDisk = (target: string): boolean =>
      [target, ...sourceCandidates(target)].some((path) => existsSync(join(REPO_ROOT, path)))
    const dangling = dropped
      .filter(({ target }) => !onDisk(target))
      .map(({ from, specifier }) => `${from} -> ${specifier}`)
    expect(dangling).toEqual([])
  })

  it('lists every edge the cycle graph drops from shipped source', () => {
    const unlisted = dropped
      .filter(({ from }) => isShipped(from))
      .map(({ from, specifier }) => `${from} -> ${specifier}`)
      .filter((key) => UNRESOLVED_IN_SHIPPED_SOURCE[key] === undefined)
    expect(
      unlisted,
      'a shipped file has a relative import that resolves to no .ts/.tsx, so the cycle scan drops ' +
        'it silently. If it is an asset, add it to UNRESOLVED_IN_SHIPPED_SOURCE and say which; ' +
        'if it is a module, the resolver has a gap.',
    ).toEqual([])
  })

  it('keeps every UNRESOLVED_IN_SHIPPED_SOURCE entry a real dropped edge with a reason', () => {
    const real = new Set(
      dropped
        .filter(({ from }) => isShipped(from))
        .map(({ from, specifier }) => `${from} -> ${specifier}`),
    )
    const stale = Object.entries(UNRESOLVED_IN_SHIPPED_SOURCE)
      .filter(([key, reason]) => !real.has(key) || reason.trim().length <= 20)
      .map(([key]) => key)
    expect(stale, 'drop the entry, or give it a reason').toEqual([])
  })
})
