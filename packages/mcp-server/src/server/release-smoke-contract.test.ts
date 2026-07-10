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
  const releaseWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/release.yml'), 'utf-8')

  it('defines a packaged-artifact smoke for the MCP package and root workspace', () => {
    expect(mcpPackage.scripts['smoke:packaged']).toBe(
      'node scripts/smoke/mcp-e2e-smoke.mjs --entry=dist/server/mcp/index.js',
    )
    expect(rootPackage.scripts['smoke:packaged']).toBe(
      'pnpm --filter @kamiazya/whiteboard-mcp smoke:packaged',
    )
    expect(mcpPackage.scripts['smoke:tarball']).toBe(
      'node --import tsx/esm scripts/smoke/mcp-packed-tarball-smoke.mjs',
    )
    expect(rootPackage.scripts['smoke:tarball']).toBe(
      'pnpm --filter @kamiazya/whiteboard-mcp smoke:tarball',
    )
    expect(mcpPackage.scripts['smoke:codex-config']).toBe(
      'node --import tsx/esm scripts/smoke/mcp-codex-config-smoke.mjs',
    )
    expect(rootPackage.scripts['smoke:codex-config']).toBe(
      'pnpm --filter @kamiazya/whiteboard-mcp smoke:codex-config',
    )
  })

  it('runs the packaged and tarball smokes as publish-tier gates, before npm publish', () => {
    // The packaged/tarball smokes are no longer standalone release.yml steps —
    // they are `publish`-tier gates in release-gate-matrix.json, executed in
    // matrix order by the single `pnpm publish-gate` step. That step must
    // still run after build and before `npm publish`.
    const matrix = readJson(resolve(repoRoot, 'tests/e2e/distribution/release-gate-matrix.json'))
    const publishGateIds: string[] = matrix.gates
      .filter((g: { requiredFor: string[] }) => g.requiredFor.includes('publish'))
      .map((g: { id: string }) => g.id)
    expect(publishGateIds).toContain('build')
    expect(publishGateIds).toContain('smoke:packaged')
    expect(publishGateIds).toContain('smoke:tarball')
    expect(publishGateIds.indexOf('build')).toBeLessThan(publishGateIds.indexOf('smoke:packaged'))
    expect(publishGateIds.indexOf('build')).toBeLessThan(publishGateIds.indexOf('smoke:tarball'))

    const publishGateStepIndex = releaseWorkflow.indexOf('run: pnpm publish-gate')
    const publishIndex = releaseWorkflow.indexOf('- name: Publish to npm')
    expect(publishGateStepIndex).toBeGreaterThan(-1)
    expect(publishIndex).toBeGreaterThan(publishGateStepIndex)
  })

  it('does not run smoke:codex-config in the publish-mcp job (verify-covered node correctness smoke, not a publishability check)', () => {
    const publishMcpStart = releaseWorkflow.indexOf('\n  publish-mcp:')
    const publishMcpEnd = releaseWorkflow.indexOf('\n  docker-publish-sign:')
    const publishMcpSection = releaseWorkflow.slice(publishMcpStart, publishMcpEnd)
    expect(publishMcpSection).not.toContain('smoke:codex-config')
  })
})
