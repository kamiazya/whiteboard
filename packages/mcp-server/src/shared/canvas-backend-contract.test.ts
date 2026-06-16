/**
 * Hermetic export-resolution test for the browser-contract subpath.
 *
 * Asserts that:
 * 1. The package.json exports map contains the ./browser-contract subpath.
 * 2. The built artifacts (js + d.ts) exist at the mapped paths.
 * 3. The built JS module exports the expected Zod schema names.
 *
 * The build step (tsc -p tsconfig.server.json) runs in beforeAll so all
 * three cases share the same precondition regardless of execution order or
 * test isolation flags.
 *
 * The artifact check searches the emitted source text for exported symbol
 * names rather than importing through the package exports map. This is
 * intentional: the subpath export resolution exercised here is a static
 * package.json contract; the runtime import path is covered by the smoke
 * suite (pnpm smoke:e2e).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '../..')

const jsPath = resolve(packageRoot, 'dist/shared/canvas-backend-contract.js')
const dtsPath = resolve(packageRoot, 'dist/shared/canvas-backend-contract.d.ts')

beforeAll(() => {
  // Always rebuild so the test never passes against a stale artifact from an
  // earlier source state. dist/ is gitignored, so a missing artifact is also
  // handled here.
  //
  // node_modules/.bin/tsc is a pnpm shell shim, not a JS module — invoke node
  // with the real TypeScript CLI entry point directly to avoid shell exec.
  const tscJs = resolve(packageRoot, 'node_modules/.bin/../typescript/bin/tsc')
  const result = spawnSync('node', [tscJs, '-p', resolve(packageRoot, 'tsconfig.server.json')], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`tsc failed:\n${result.stderr}`)
  }
}, 60_000)

describe('browser-contract subpath export', () => {
  it('package.json exports map includes ./browser-contract', () => {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>
    }
    expect(pkg.exports?.['./browser-contract']).toBeDefined()
    const entry = pkg.exports?.['./browser-contract'] as Record<string, string>
    expect(entry.import).toMatch(/canvas-backend-contract\.js$/)
    expect(entry.types).toMatch(/canvas-backend-contract\.(d\.)?ts$/)
  })

  it('dist/shared/canvas-backend-contract.{js,d.ts} exist', () => {
    expect(existsSync(jsPath), `missing: ${jsPath}`).toBe(true)
    expect(existsSync(dtsPath), `missing: ${dtsPath}`).toBe(true)
  })

  it('built JS module exports Zod schemas (Zod SoT intact)', () => {
    expect(existsSync(jsPath), `artifact missing: ${jsPath}`).toBe(true)

    // String-presence scan on the emitted source confirms the schema names
    // survive the tsc emit without executing the module through Vite's pipeline.
    const src = readFileSync(jsPath, 'utf8')
    expect(src).toContain('versionCreatedMessageSchema')
    expect(src).toContain('serverTextMessageSchema')
    expect(src).toContain('clientTextMessageSchema')
  })
})
