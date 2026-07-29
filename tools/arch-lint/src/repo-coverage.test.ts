import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkAllowedDependencies } from './allowed-deps-check.js'
import { packagesAllowedToImportLoroCrdt } from './architecture-map.js'
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
]

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

describe('shared-layer boundary lint (real source coverage)', () => {
  for (const packageDir of SHARED_LAYER_PACKAGES) {
    it(`${packageDir}/src has zero boundary violations`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      // loro-crdt is a legitimate import ONLY for packages architecture-map.ts
      // explicitly lists as allowed to declare it — never an implicit "it's a
      // dependency, so allow it" heuristic, so an unmapped package that adds
      // loro-crdt still fails loudly via `allowed-deps-check`.
      const loroCrdtIsExempt = packagesAllowedToImportLoroCrdt().includes(manifest.name)

      const srcDir = join(REPO_ROOT, packageDir, 'src')
      const files = listTsFiles(srcDir)
      expect(files.length).toBeGreaterThan(0)

      for (const file of files) {
        const allViolations = scanSourceForBoundaryViolations(file, readFileSync(file, 'utf-8'))
        const violations = loroCrdtIsExempt
          ? allViolations.filter((v) => v.kind !== 'loro-crdt-import')
          : allViolations
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
})
