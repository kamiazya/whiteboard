/**
 * Hermetic export-resolution test for the browser-contract subpath.
 *
 * Asserts that:
 * 1. The package.json exports map contains the ./browser-contract subpath.
 * 2. The built artifacts (js + d.ts) exist at the mapped paths.
 * 3. The built JS module exports the expected Zod schema names.
 *
 * The build step (tsc -p tsconfig.server.json) is invoked via Node's child_process
 * so this remains hermetic on a clean checkout where dist/ is untracked.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '../..')

describe('browser-contract subpath export', () => {
  it('package.json exports map includes ./browser-contract', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as { exports?: Record<string, unknown> }
    expect(pkg.exports?.['./browser-contract']).toBeDefined()
    const entry = pkg.exports?.['./browser-contract'] as Record<string, string>
    expect(entry.import).toMatch(/canvas-backend-contract\.js$/)
    expect(entry.types).toMatch(/canvas-backend-contract\.d\.ts$/)
  })

  it('dist/shared/canvas-backend-contract.{js,d.ts} exist (builds if needed)', () => {
    const jsPath = resolve(packageRoot, 'dist/shared/canvas-backend-contract.js')
    const dtsPath = resolve(
      packageRoot,
      'dist/shared/canvas-backend-contract.d.ts',
    )
    if (!existsSync(jsPath) || !existsSync(dtsPath)) {
      // Build only the server/shared declaration pass.
      const result = spawnSync(
        'node',
        [
          resolve(packageRoot, 'node_modules/.bin/tsc'),
          '-p',
          resolve(packageRoot, 'tsconfig.server.json'),
        ],
        { cwd: packageRoot, encoding: 'utf8' },
      )
      expect(result.status, `tsc failed:\n${result.stderr}`).toBe(0)
    }
    expect(existsSync(jsPath), `missing: ${jsPath}`).toBe(true)
    expect(existsSync(dtsPath), `missing: ${dtsPath}`).toBe(true)
  })

  it('built JS module exports Zod schemas (Zod SoT intact)', () => {
    const jsPath = resolve(packageRoot, 'dist/shared/canvas-backend-contract.js')
    // Use CJS require so we can inspect exports synchronously without vite
    // module-graph interference. The built file uses ESM syntax but the dist
    // resolver in Node supports dynamic import — we assert on the file path directly.
    expect(existsSync(jsPath), `artifact missing: ${jsPath}`).toBe(true)

    // Read source to confirm schema names are exported (structural check on the
    // built JS without executing it through vite's transform pipeline).
    const src = readFileSync(jsPath, 'utf8')
    expect(src).toContain('versionCreatedMessageSchema')
    expect(src).toContain('serverTextMessageSchema')
    expect(src).toContain('clientTextMessageSchema')
  })
})
