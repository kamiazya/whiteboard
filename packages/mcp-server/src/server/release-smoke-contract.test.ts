import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function jobSection(text: string, jobId: string, nextJobId?: string): string {
  const marker = `  ${jobId}:`
  const start = text.indexOf(marker)
  if (start === -1) return ''
  if (nextJobId) {
    const nextMarker = `  ${nextJobId}:`
    const end = text.indexOf(nextMarker, start)
    return end === -1 ? text.slice(start) : text.slice(start, end)
  }
  return text.slice(start)
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
      'vitest run --config vitest.distribution.config.ts packaged',
    )
    expect(rootPackage.scripts['smoke:packaged']).toBe(
      'pnpm --filter @kamiazya/whiteboard-mcp smoke:packaged',
    )
    expect(mcpPackage.scripts['smoke:tarball']).toBe(
      'vitest run --config vitest.distribution.config.ts tarball',
    )
    expect(rootPackage.scripts['smoke:tarball']).toBe(
      'pnpm --filter @kamiazya/whiteboard-mcp smoke:tarball',
    )
    expect(mcpPackage.scripts['smoke:codex-config']).toBe(
      'vitest run --config vitest.distribution.config.ts codex-config',
    )
    expect(rootPackage.scripts['smoke:codex-config']).toBe(
      'pnpm --filter @kamiazya/whiteboard-mcp smoke:codex-config',
    )
  })

  it('invokes check:release-candidate before npm publish, covering packaged/tarball/codex smokes', () => {
    // Scope the search to the publish-mcp job only so another job that happens to
    // call check:release-candidate (e.g. docker-publish-sign calls :docker) cannot
    // satisfy this assertion.
    const publishMcpSection = jobSection(releaseWorkflow, 'publish-mcp', 'docker-publish-sign')
    expect(publishMcpSection, 'publish-mcp job must exist in release.yml').not.toBe('')
    const releaseGateIdx = publishMcpSection.indexOf('pnpm check:release-candidate')
    const publishIndex = publishMcpSection.indexOf('- name: Publish to npm')
    expect(releaseGateIdx, 'publish-mcp job must call pnpm check:release-candidate').toBeGreaterThanOrEqual(0)
    expect(publishIndex, 'Publish to npm step must be present in publish-mcp job').toBeGreaterThanOrEqual(0)
    expect(releaseGateIdx, 'check:release-candidate must precede npm publish').toBeLessThan(publishIndex)

    // check:release-candidate (via test:e2e:distribution) must cover the three smokes.
    const releaseCandidate: string = rootPackage.scripts['check:release-candidate']
    const testE2eDist: string = rootPackage.scripts['test:e2e:distribution']
    expect(releaseCandidate, 'check:release-candidate must call test:e2e:distribution').toContain('test:e2e:distribution')
    expect(testE2eDist, 'test:e2e:distribution must include smoke:packaged').toContain('smoke:packaged')
    expect(testE2eDist, 'test:e2e:distribution must include smoke:tarball').toContain('smoke:tarball')
    expect(testE2eDist, 'test:e2e:distribution must include smoke:codex-config').toContain('smoke:codex-config')
  })
})
