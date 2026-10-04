/**
 * The `server-core` subpaths `daemon-client` imports must stay LIGHT in what
 * they pull in, not only in which entry they are.
 *
 * `daemon-client-subpath.test.ts` pins that the root barrel is never
 * imported. That is the necessary half and not the sufficient one: a subpath
 * is a file, and a file that value-imports a heavy package makes the subpath
 * heavy again. Measured twice (see that test's header), a heavy import on the
 * critical path cost 269 KB and 144 -> 414 KB of gzipped JS against a 152 KB
 * budget, and only a built bundle showed it.
 *
 * So this walks the VALUE-import closure of each subpath — through
 * server-core's own modules and across workspace packages, resolved by their
 * `exports` maps — and fails on a path into:
 *
 * - `loro-crdt`, `hono`, and the markdown pipeline (`unified`, `remark*`,
 *   `mdast*`, `micromark*`);
 * - the ROOT barrel of reference-graph, codec, canvas-render, plugin-visual
 *   or loro-adapter. Each of those roots reaches the markdown pipeline, the
 *   CRDT or a catalog the size of the emoji table; a schema one of them owns
 *   is imported through a schemas-only subpath instead.
 *
 * Type-only imports are erased at build and not counted. A violation is not
 * allowlisted: the fix is a subpath, or moving the schema below the heavy
 * package, never an exemption — an exemption here is a bundle-size
 * regression with a note on it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'
import { REPO_ROOT, walk } from './scan-roots.js'
import { collectModuleSpecifiers } from './scanner.js'
import {
  type ClosureHost,
  resolveRelativeSource,
  resolveWorkspaceSource,
  type WorkspaceManifest,
  walkValueImportClosure,
} from './value-import-closure.js'

const SERVER_CORE = '@kamiazya/whiteboard-server-core'
const DAEMON_CLIENT_SRC = join(REPO_ROOT, 'packages', 'daemon-client', 'src')

const HEAVY_EXTERNAL =
  /^(loro-crdt|hono|unified|remark(-[\w-]+)?|mdast(-[\w-]+)?|micromark(-[\w-]+)?)(\/|$)/

const HEAVY_WORKSPACE_ROOTS = new Set(
  ['reference-graph', 'codec', 'canvas-render', 'plugin-visual', 'loro-adapter'].map(
    (name) => `@kamiazya/whiteboard-${name}`,
  ),
)

/** Why a specifier is forbidden in the closure, or `null`. */
function heavyReason(specifier: string): string | null {
  if (HEAVY_EXTERNAL.test(specifier)) return 'a heavy third-party module'
  if (HEAVY_WORKSPACE_ROOTS.has(specifier)) return 'the root barrel of a heavy workspace package'
  return null
}

/**
 * A forbidden specifier is reported where it is imported and not entered: the
 * whole graph behind a heavy root is the same one finding, and listing it
 * would bury the import that has to change.
 */
function resolveInto(specifier: string, resolve: () => string | null): string | null {
  return heavyReason(specifier) === null ? resolve() : null
}

interface Violation {
  readonly file: string
  readonly specifier: string
  readonly reason: string
  readonly via: readonly string[]
}

function violationsFrom(entries: readonly string[], host: ClosureHost): Violation[] {
  const { imports } = walkValueImportClosure(entries, host)
  const found: Violation[] = []
  for (const reached of imports) {
    const reason = heavyReason(reached.specifier)
    if (reason !== null) {
      found.push({ file: reached.from, specifier: reached.specifier, reason, via: reached.via })
    }
  }
  return found
}

function fixture(
  sources: Record<string, string>,
  packages: Record<string, WorkspaceManifest> = {},
): ClosureHost {
  const manifests = new Map(Object.entries(packages))
  return {
    read: (path) => sources[path] ?? '',
    resolve: (from, specifier) =>
      resolveInto(
        specifier,
        () =>
          resolveRelativeSource(from, specifier, (p) => p in sources) ??
          resolveWorkspaceSource(specifier, manifests),
      ),
  }
}

describe('the guard itself', () => {
  const lib = (dir: string, exports: WorkspaceManifest['exports']): WorkspaceManifest => ({
    dir,
    exports,
  })

  it('finds loro-crdt reached through another workspace package, and names the way in', () => {
    const host = fixture(
      {
        'sc/entry.ts': `import { a } from '@kamiazya/whiteboard-light'`,
        'light/src/index.ts': `export { b } from './b.js'`,
        'light/src/b.ts': `import { LoroDoc } from 'loro-crdt'\nexport const b = LoroDoc`,
      },
      { '@kamiazya/whiteboard-light': lib('light', { '.': './src/index.ts' }) },
    )
    expect(violationsFrom(['sc/entry.ts'], host)).toEqual([
      {
        file: 'light/src/b.ts',
        specifier: 'loro-crdt',
        reason: 'a heavy third-party module',
        via: ['sc/entry.ts', 'light/src/index.ts', 'light/src/b.ts'],
      },
    ])
  })

  it('finds a heavy workspace ROOT but lets a subpath of the same package through', () => {
    const packages = {
      '@kamiazya/whiteboard-codec': lib('codec', {
        '.': './src/index.ts',
        './okf-schema': './src/okf-schema.ts',
      }),
    }
    const root = fixture(
      { 'sc/e.ts': `import { x } from '@kamiazya/whiteboard-codec'`, 'codec/src/index.ts': '' },
      packages,
    )
    expect(violationsFrom(['sc/e.ts'], root).map((v) => v.reason)).toEqual([
      'the root barrel of a heavy workspace package',
    ])
    const sub = fixture(
      {
        'sc/e.ts': `import { x } from '@kamiazya/whiteboard-codec/okf-schema'`,
        'codec/src/okf-schema.ts': `import { z } from 'zod'`,
      },
      packages,
    )
    expect(violationsFrom(['sc/e.ts'], sub)).toEqual([])
  })

  it('recognises the markdown pipeline by prefix, and not a lookalike', () => {
    for (const specifier of [
      'unified',
      'remark-parse',
      'remark',
      'mdast-util-to-string',
      'micromark/lib/x',
      'hono/cors',
    ]) {
      expect(heavyReason(specifier), specifier).not.toBeNull()
    }
    for (const specifier of ['zod', 'remarkable-thing', 'honolulu', 'loro-crdt-types-lookalike']) {
      expect(heavyReason(specifier), specifier).toBeNull()
    }
  })

  it('does not count a type-only import, which is erased at build', () => {
    const host = fixture({
      'sc/e.ts': `import type { LoroDoc } from 'loro-crdt'\nimport { type A } from 'hono'\nexport type T = LoroDoc | A`,
    })
    expect(violationsFrom(['sc/e.ts'], host)).toEqual([])
  })

  it('refuses to guess when a package does not export the subpath it was asked for', () => {
    const host = fixture(
      { 'sc/e.ts': `import { x } from '@kamiazya/whiteboard-light/missing'` },
      { '@kamiazya/whiteboard-light': lib('light', { '.': './src/index.ts' }) },
    )
    expect(() => violationsFrom(['sc/e.ts'], host)).toThrow(/does not export '\.\/missing'/)
  })
})

function workspaceManifests(): Map<string, WorkspaceManifest> {
  const manifests = new Map<string, WorkspaceManifest>()
  const packagesDir = join(REPO_ROOT, 'packages')
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    const manifestPath = join(packagesDir, entry.name, 'package.json')
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      name: string
      exports?: WorkspaceManifest['exports']
      main?: string
    }
    manifests.set(manifest.name, {
      dir: join(packagesDir, entry.name),
      exports: manifest.exports,
      main: manifest.main,
    })
  }
  return manifests
}

/** Every `server-core` subpath a non-test daemon-client source names, type-only included. */
function importedSubpaths(): string[] {
  const subpaths = new Set<string>()
  const files = walk(DAEMON_CLIENT_SRC, {
    include: (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  })
  for (const file of files) {
    const source = parseSource(file, readFileSync(file, 'utf-8'))
    for (const { specifier } of collectModuleSpecifiers(source)) {
      if (specifier.startsWith(`${SERVER_CORE}/`)) subpaths.add(specifier)
    }
  }
  return [...subpaths].sort()
}

const manifests = workspaceManifests()
const realHost: ClosureHost = {
  read: (path) => readFileSync(path, 'utf-8'),
  resolve: (from, specifier) =>
    resolveInto(
      specifier,
      () =>
        resolveRelativeSource(from, specifier, (p) => existsSync(p) && statSync(p).isFile()) ??
        resolveWorkspaceSource(specifier, manifests),
    ),
}
const rel = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')

describe('the server-core subpaths daemon-client imports reach nothing heavy', () => {
  const subpaths = importedSubpaths()
  const entries = subpaths.map(
    (specifier) => resolveWorkspaceSource(specifier, manifests) as string,
  )

  it('finds the subpaths daemon-client really imports, each resolving to a source file', () => {
    // Four today (api-errors, contracts, search-query, versions/version-entry,
    // viewport-request is a fifth); a scan that read none would report clean.
    expect(subpaths.length).toBeGreaterThanOrEqual(4)
    expect(subpaths).toContain(`${SERVER_CORE}/contracts`)
    for (const entry of entries) expect(existsSync(entry), entry).toBe(true)
  })

  it('reaches into other workspace packages, so the walk is more than one package deep', () => {
    const { files } = walkValueImportClosure(entries, realHost)
    expect(files.length).toBeGreaterThan(8)
    expect(files.some((file) => !rel(file).startsWith('packages/server-core/'))).toBe(true)
  })

  it('value-imports no heavy module, directly or through any workspace package', () => {
    const offenders = violationsFrom(entries, realHost).map(
      (v) =>
        `${rel(v.file)} imports '${v.specifier}' (${v.reason}); reached via ${v.via.map(rel).join(' -> ')}`,
    )
    expect(offenders).toEqual([])
  })
})
