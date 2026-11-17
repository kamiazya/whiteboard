/**
 * The Rust jobs' path scope (`tools/checks/src/rust-scope.mjs`) holds every
 * canvas-render file the `canvas-render-rust` project loads.
 *
 * Since ADR-0054 step 7's S18h the layout scoreboards and the recorded
 * replays run only there, in the `rust` CI job, and that job is selected by
 * PATH, not by the pnpm graph. So a change to the TypeScript that BUILDS the
 * core's request — the canvas switch, the measurer's spec, the reference
 * wire, the theme a request carries — reaches the core's answer without
 * reaching the scope, and the PR runs no scoreboard at all. Nothing else
 * fails: the paths exist, the scope's own existence check passes, and the
 * TS jobs it does select do not run the `.rust.test.ts` files.
 *
 * The scope stays an explicit list, which the scope job reads without
 * parsing TypeScript. What this derives is the requirement: the VALUE-import
 * closure, inside canvas-render, of every file the project includes, each of
 * which must lie in one of the scope's trees or be one of its files. A new
 * import from a rust test into an unscoped module fails here, naming the
 * chain that reaches it.
 *
 * Type-only imports are not followed: they are erased, so they cannot move
 * what a test computes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import {
  type ClosureHost,
  resolveRelativeSource,
  resolveWorkspaceSource,
  type WorkspaceManifest,
  walkValueImportClosure,
} from './value-import-closure.js'

const PACKAGE = 'packages/canvas-render'
const PACKAGE_DIR = join(REPO_ROOT, PACKAGE)
const SELF = '@kamiazya/whiteboard-canvas-render'

// lazy-import: loaded by path, since a relative import of tools/checks leaves
// this workspace and `relative-import-escape` refuses it.
const { RUST_SCOPE: scope } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/rust-scope.mjs')).href
)) as { RUST_SCOPE: { files: readonly string[]; trees: readonly string[] } }

/** What `vitest.rust.config.ts` includes: the rust tests, the rust benches, the edge suites. */
const ENTRY = /(?:\.rust\.(?:test|bench)\.ts|^src\/layout\/edges\/.*\.test\.ts)$/

function walk(dir: string, into: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, into)
    else into.push(path)
  }
  return into
}

const toRepo = (absolute: string) => relative(REPO_ROOT, absolute).split(sep).join('/')

function entries(): string[] {
  return walk(join(PACKAGE_DIR, 'src'), [])
    .map((path) => relative(PACKAGE_DIR, path).split(sep).join('/'))
    .filter((path) => ENTRY.test(path))
    .map((path) => `${PACKAGE}/${path}`)
    .sort()
}

const manifest = JSON.parse(
  readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'),
) as WorkspaceManifest
const packages = new Map<string, WorkspaceManifest>([[SELF, { ...manifest, dir: PACKAGE_DIR }]])

const host: ClosureHost = {
  read: (path) => readFileSync(join(REPO_ROOT, path), 'utf8'),
  resolve: (from, specifier) => {
    const exists = (path: string) => existsSync(join(REPO_ROOT, path))
    const relativeTarget = resolveRelativeSource(from, specifier, exists)
    if (relativeTarget !== null) return relativeTarget
    if (specifier !== SELF && !specifier.startsWith(`${SELF}/`)) return null
    const target = resolveWorkspaceSource(specifier, packages)
    return target === null ? null : toRepo(target)
  },
}

const inScope = (path: string) =>
  scope.files.includes(path) || scope.trees.some((tree) => path.startsWith(`${tree}/`))

describe("the Rust jobs' scope holds what canvas-render-rust loads", () => {
  const found = entries()

  it('finds the project it judges', () => {
    // An empty entry list agrees with every scope.
    expect(found.length).toBeGreaterThan(20)
    expect(found).toContain(`${PACKAGE}/src/layout/nodes/text-wrapping-quality.rust.test.ts`)
  })

  it('scopes every canvas-render file a rust test, bench or edge suite loads', () => {
    const { files, chainTo } = walkValueImportClosure(found, host)
    const own = files.filter((path) => path.startsWith(`${PACKAGE}/`))
    // The walk reaches well past the tests themselves, or it resolved nothing.
    expect(own.length).toBeGreaterThan(found.length)
    const unscoped = own
      .filter((path) => !inScope(path))
      .map((path) => `${path}\n    via ${chainTo(path).join(' -> ')}`)
    expect(unscoped, 'add each to RUST_SCOPE (a file, or a tree that holds it)').toEqual([])
  })
})
