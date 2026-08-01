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
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const WORKSPACE_SCOPE = '@kamiazya/whiteboard-'

// canvas-viewer is consumed as a built widget artifact copied off disk by
// scripts/copy-widget-into-dist.mjs, never imported from source — so it is
// the one workspace package that legitimately has no noExternal entry.
const NOT_BUNDLED = new Set([`${WORKSPACE_SCOPE}canvas-viewer`])

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

// The @kamiazya/whiteboard-* workspace packages are private and never
// published, so a published `dependencies` entry for one is unresolvable:
// `pnpm add <tarball>` fails with ERR_PNPM_FETCH_404 for every consumer.
// tsup inlines them into dist instead (packaging decision B, see
// tsup.config.ts). Without these two assertions the only thing that catches
// the mistake is the packed-tarball smoke, which needs a full build plus a
// real install — these fail in milliseconds instead.
describe('private workspace packages are bundled, never published as deps', () => {
  const workspaceDeps = (record: Record<string, string> | undefined): string[] =>
    Object.keys(record ?? {}).filter((name) => name.startsWith(WORKSPACE_SCOPE))

  it('declares no workspace package in dependencies', () => {
    expect(workspaceDeps(mcpPackage.dependencies)).toEqual([])
  })

  it('lists every source-imported workspace devDependency in tsup noExternal', () => {
    const tsupConfig = readFileSync(resolve(PACKAGE_ROOT, 'tsup.config.ts'), 'utf-8')
    const expected = workspaceDeps(mcpPackage.devDependencies).filter(
      (name) => !NOT_BUNDLED.has(name),
    )
    // Guards the mirror failure of the case above: a workspace dep that tsup
    // does not inline leaves dist importing a specifier nothing can resolve.
    expect(expected.length).toBeGreaterThan(0)
    for (const name of expected) {
      expect(tsupConfig).toContain(`'${name}'`)
    }
  })
})
