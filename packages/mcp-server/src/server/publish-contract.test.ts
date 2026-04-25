import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('publish contract', () => {
  const rootPackage = readJson(resolve(repoRoot, 'package.json'))
  const mcpPackagePath = resolve(repoRoot, 'packages/mcp-server/package.json')
  const mcpPackage = readJson(mcpPackagePath)
  const manifest = readJson(resolve(repoRoot, '.release-please-manifest.json'))
  const releaseWorkflow = readFileSync(
    resolve(repoRoot, '.github/workflows/release.yml'),
    'utf-8',
  )

  it('keeps release-please manifest versions in sync with package.json files', () => {
    expect(rootPackage.version).toBe(manifest['.'])
    expect(mcpPackage.version).toBe(manifest['packages/mcp-server'])
  })

  it('ships npm-facing package docs and license files from the package directory', () => {
    expect(existsSync(resolve(repoRoot, 'packages/mcp-server/README.md'))).toBe(true)
    expect(existsSync(resolve(repoRoot, 'packages/mcp-server/LICENSE'))).toBe(true)
    expect(mcpPackage.files).toContain('README.md')
    expect(mcpPackage.files).toContain('LICENSE')
  })

  it('declares the public npm publish contract in package metadata', () => {
    expect(mcpPackage.engines).toEqual({ node: '>=22' })
    expect(mcpPackage.publishConfig).toMatchObject({
      registry: 'https://registry.npmjs.org',
      access: 'public',
    })
    expect(mcpPackage.homepage).toBeTruthy()
    expect(mcpPackage.bugs?.url).toBeTruthy()
  })

  it('publishes to npm via OIDC trusted publisher (no NPM_TOKEN, with provenance)', () => {
    expect(releaseWorkflow).toContain('Publish to npm')
    expect(releaseWorkflow).toContain('registry-url: https://registry.npmjs.org')
    expect(releaseWorkflow).toContain('pnpm --filter @kamiazya/whiteboard-mcp exec playwright install --with-deps chromium')
    expect(releaseWorkflow).toContain('npm publish --access public --provenance')
    // OIDC trusted publisher requires id-token: write permission and bumps npm to >= 11.5.1.
    expect(releaseWorkflow).toContain('id-token: write')
    expect(releaseWorkflow).toMatch(/npm install -g(?: --force)? npm@latest/)
    // Should not fall back to long-lived NPM_TOKEN or GitHub Packages auth.
    expect(releaseWorkflow).not.toContain('Publish to GitHub Packages')
    expect(releaseWorkflow).not.toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}')
    expect(releaseWorkflow).not.toContain('NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
  })
})
