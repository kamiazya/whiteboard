import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDependencyDirection } from './direction-check.js'
import { scanSourceForBoundaryViolations } from './scanner.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
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
      // loro-crdt is a declared runtime dependency (and thus a legitimate
      // import) for packages that own the LoroDoc<->model bridge —
      // everywhere else it's still a boundary violation.
      const loroCrdtIsDeclaredDependency = 'loro-crdt' in (manifest.dependencies ?? {})

      const srcDir = join(REPO_ROOT, packageDir, 'src')
      const files = listTsFiles(srcDir)
      expect(files.length).toBeGreaterThan(0)

      for (const file of files) {
        const allViolations = scanSourceForBoundaryViolations(file, readFileSync(file, 'utf-8'))
        const violations = loroCrdtIsDeclaredDependency
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
  }
})
