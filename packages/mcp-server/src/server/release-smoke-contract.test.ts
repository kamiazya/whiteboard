import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('release smoke contract', () => {
  const rootPackage = readJson(resolve(repoRoot, 'package.json'))
  const mcpPackage = readJson(resolve(repoRoot, 'packages/mcp-server/package.json'))
  const releaseWorkflow = readFileSync(
    resolve(repoRoot, '.github/workflows/release.yml'),
    'utf-8',
  )

  it('defines a packaged-artifact smoke for the MCP package and root workspace', () => {
    expect(mcpPackage.scripts['smoke:packaged']).toBe(
      'node scripts/mcp-e2e-checkpoint.mjs --entry=dist/server/mcp/index.js',
    )
    expect(rootPackage.scripts['smoke:packaged']).toBe(
      'pnpm --filter @kamiazya/whiteboard-mcp smoke:packaged',
    )
    expect(mcpPackage.scripts['smoke:codex-config']).toBe(
      'node scripts/mcp-codex-config-smoke.mjs',
    )
    expect(rootPackage.scripts['smoke:codex-config']).toBe(
      'pnpm --filter @kamiazya/whiteboard-mcp smoke:codex-config',
    )
  })

  it('runs the packaged and Codex config smokes after build and before npm publish', () => {
    const buildIndex = releaseWorkflow.indexOf('- name: Build')
    const packagedSmokeIndex = releaseWorkflow.indexOf('- name: Packaged stdio smoke')
    const codexSmokeIndex = releaseWorkflow.indexOf('- name: Codex config smoke')
    const publishIndex = releaseWorkflow.indexOf('- name: Publish to npm')

    expect(packagedSmokeIndex).toBeGreaterThan(buildIndex)
    expect(codexSmokeIndex).toBeGreaterThan(packagedSmokeIndex)
    expect(publishIndex).toBeGreaterThan(codexSmokeIndex)
    expect(releaseWorkflow).toContain('run: pnpm smoke:packaged')
    expect(releaseWorkflow).toContain('run: pnpm smoke:codex-config')
  })
})
