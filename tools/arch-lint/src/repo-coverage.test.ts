import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkAllowedDependencies } from './allowed-deps-check.js'
import { exemptedBoundaryViolationKinds } from './architecture-map.js'
import { checkDependencyDirection } from './direction-check.js'
import { scanSourceForBoundaryViolations } from './scanner.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const ARCHITECTURE_MAP_DOC = join(REPO_ROOT, '.claude', 'rules', 'architecture-map.md')
const SHARED_LAYER_PACKAGES = [
  'packages/canvas-model',
  'packages/canvas-codec',
  'packages/canvas-render',
  'packages/canvas-ports',
  'packages/canvas-workspace',
  'packages/server-core',
  // Browser-runtime UI package, not a "shared" model/codec/... layer package
  // in the architecture-map.md sense, but scanned the same way — see its
  // `exemptBoundaryViolationKinds` entry in architecture-map.ts for why DOM
  // globals and one build-time `Buffer` use don't trip the scan.
  'packages/canvas-viewer',
]

/**
 * Composition roots. Their SOURCE is deliberately unscanned — they are the
 * packages allowed `node:*`, DOM globals and inversify — and their
 * third-party surface is open by design, so they cannot join the list above.
 * Their dependency DIRECTION is still a rule, and it was the one thing
 * nothing checked: `apps/web` was absent from the map entirely, so a shared
 * package taking a dependency on it would have passed.
 */
const COMPOSITION_ROOTS = ['apps/web', 'packages/mcp-server']

function listTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

describe('composition-root dependency direction', () => {
  for (const packageDir of COMPOSITION_ROOTS) {
    it(`${packageDir}/package.json dependency direction is clean`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      expect(checkDependencyDirection(manifest)).toHaveLength(0)
    })
  }
})

describe('shared-layer boundary lint (real source coverage)', () => {
  for (const packageDir of SHARED_LAYER_PACKAGES) {
    it(`${packageDir}/src has zero boundary violations`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      // A violation kind is a legitimate exemption ONLY for packages
      // architecture-map.ts explicitly lists it for — never an implicit "it's
      // used here, so allow it" heuristic, so an unmapped package still fails
      // loudly.
      const exemptKinds = exemptedBoundaryViolationKinds(manifest.name)

      const srcDir = join(REPO_ROOT, packageDir, 'src')
      const files = listTsFiles(srcDir)
      expect(files.length).toBeGreaterThan(0)

      for (const file of files) {
        const allViolations = scanSourceForBoundaryViolations(file, readFileSync(file, 'utf-8'))
        const violations = allViolations.filter((v) => !exemptKinds.has(v.kind))
        expect(violations, `${file}: ${JSON.stringify(violations)}`).toHaveLength(0)
      }
    })

    it(`${packageDir}/package.json dependency direction is clean`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      const violations = checkDependencyDirection(manifest)
      expect(violations).toHaveLength(0)
    })

    it(`${packageDir}/package.json has no unlisted third-party dependency`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      const violations = checkAllowedDependencies(manifest)
      expect(violations).toHaveLength(0)
    })
  }
})

describe('architecture-map.md doc sync', () => {
  const doc = readFileSync(ARCHITECTURE_MAP_DOC, 'utf-8')

  it('lists every SHARED_LAYER_PACKAGES entry in its prose', () => {
    const missing = SHARED_LAYER_PACKAGES.map(
      (packageDir) => packageDir.split('/').pop() as string,
    ).filter((basename) => !doc.includes(basename))
    expect(missing).toHaveLength(0)
  })

  it('no longer contains the stale "currently covers canvas-model and canvas-codec" claim', () => {
    expect(doc).not.toContain('It currently covers `canvas-model` and `canvas-codec`')
  })

  // The rule file answers "is this checked?", and for a composition root the
  // answer is split: this tool checks the manifest's direction, while
  // web-app-boundary.test.ts scans apps/web's source. A reader who only finds
  // one of the two concludes the other is unguarded.
  it('names every COMPOSITION_ROOTS entry and the enforcer that scans apps/web source', () => {
    const missing = COMPOSITION_ROOTS.filter((packageDir) => !doc.includes(packageDir))
    expect(missing).toHaveLength(0)
    expect(doc).toContain('web-app-boundary.test.ts')
  })
})
