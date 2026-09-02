import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_PACKAGE_CYCLES } from './architecture-map.js'
import { findPackageCycles } from './package-cycle-check.js'

function manifest(
  name: string,
  deps: Record<string, string> = {},
  devDeps: Record<string, string> = {},
) {
  return { name, dependencies: deps, devDependencies: devDeps }
}

describe('findPackageCycles', () => {
  it('answers [] for an acyclic workspace graph, third-party deps ignored', () => {
    expect(
      findPackageCycles([
        manifest('a', { b: 'workspace:*', zod: '^3' }),
        manifest('b', { react: '^19' }),
      ]),
    ).toEqual([])
  })

  it('finds a cycle carried by dependencies', () => {
    expect(
      findPackageCycles([manifest('a', { b: 'workspace:*' }), manifest('b', { a: 'workspace:*' })]),
    ).toEqual([['a', 'b']])
  })

  it('finds a cycle CLOSED through devDependencies — the edge the direction check never inspects', () => {
    // The documented blind spot: direction-check.ts reads `dependencies`
    // only, so a devDependency is the door a cross-package loop walks in
    // through. This check exists for exactly this edge.
    expect(
      findPackageCycles([
        manifest('a', { b: 'workspace:*' }),
        manifest('b', {}, { a: 'workspace:*' }),
      ]),
    ).toEqual([['a', 'b']])
  })

  it('reports each cycle once, members sorted, deterministically', () => {
    const cycles = findPackageCycles([
      manifest('z', { a: 'workspace:*' }),
      manifest('a', { z: 'workspace:*' }),
      manifest('lonely'),
    ])
    expect(cycles).toEqual([['a', 'z']])
  })
})

describe('the real workspace', () => {
  // Enumerated from the same globs pnpm-workspace.yaml declares
  // (packages/*, apps/*, tools/*), so a new package joins this scan the
  // moment it exists — no list to keep in step.
  const REPO_ROOT = join(__dirname, '../../..')
  const manifests = ['packages', 'apps', 'tools'].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        try {
          return [
            JSON.parse(readFileSync(join(REPO_ROOT, group, entry.name, 'package.json'), 'utf-8')),
          ]
        } catch {
          return []
        }
      }),
  )

  it('enumerates a plausible manifest count', () => {
    // A scan over zero manifests would report "no cycles" while checking
    // nothing; the workspace holds 13+ packages today.
    expect(manifests.length).toBeGreaterThanOrEqual(10)
  })

  it('holds no cross-package dependency cycle beyond the allowlisted ones', () => {
    const found = findPackageCycles(manifests)
    expect(found).toEqual(KNOWN_PACKAGE_CYCLES.map((entry) => [...entry.packages].sort()).sort())
  })

  it('every allowlisted cycle still exists — an entry cannot outlive the debt it names', () => {
    const found = findPackageCycles(manifests).map((cycle) => cycle.join(' <-> '))
    for (const entry of KNOWN_PACKAGE_CYCLES) {
      expect(found).toContain([...entry.packages].sort().join(' <-> '))
      expect(entry.reason.length).toBeGreaterThan(20)
    }
  })
})
