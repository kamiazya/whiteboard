// R5 of the MCP-UI retirement (ADR 0001): the legacy browser-app build
// pipeline (vite.config.ts, build:app, the vite-driven dev script) is
// deleted. This test maps that completion criterion to a concrete assertion
// instead of relying on "pnpm build is green" as a proxy — a stray
// `build:app` script or a resurrected vite.config.ts would pass a green
// build but silently reintroduce the retired pipeline.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname → packages/mcp-server/src/server/release
const PACKAGE_ROOT = resolve(__dirname, '../../..')
const mcpPackage = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
  scripts?: Record<string, string>
  sideEffects?: string[]
}

describe('packages/mcp-server package shape (legacy build pipeline retired)', () => {
  it('has no build:app script', () => {
    expect(mcpPackage.scripts?.['build:app']).toBeUndefined()
  })

  it('build runs build:server plus the MCP Apps widget and export font copy steps, nothing else', () => {
    expect(mcpPackage.scripts?.build).toBe(
      'pnpm build:server && node scripts/copy-widget-into-dist.mjs && node scripts/copy-export-font-into-dist.mjs',
    )
  })

  it('dev does not spawn vite', () => {
    expect(mcpPackage.scripts?.dev ?? '').not.toContain('vite')
  })

  it('sideEffects is exactly the mcp server entry, no legacy browser-app CSS glob', () => {
    expect(mcpPackage.sideEffects).toEqual(['./dist/server/mcp/index.js'])
  })

  it('vite.config.ts does not exist', () => {
    expect(existsSync(resolve(PACKAGE_ROOT, 'vite.config.ts'))).toBe(false)
  })
})
