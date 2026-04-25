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
  const rootReadme = readFileSync(resolve(repoRoot, 'README.md'), 'utf-8')
  const contributing = readFileSync(resolve(repoRoot, 'CONTRIBUTING.md'), 'utf-8')
  const packageReadme = readFileSync(
    resolve(repoRoot, 'packages/mcp-server/README.md'),
    'utf-8',
  )
  const mcpDebuggingDoc = readFileSync(resolve(repoRoot, 'docs/mcp-debugging.md'), 'utf-8')
  const architectureDoc = readFileSync(resolve(repoRoot, 'docs/architecture.md'), 'utf-8')
  const securityModelDoc = readFileSync(resolve(repoRoot, 'docs/security-model.md'), 'utf-8')
  const wireProtocolDoc = readFileSync(resolve(repoRoot, 'docs/wire-protocol.md'), 'utf-8')
  const tsconfigServer = readJson(resolve(repoRoot, 'packages/mcp-server/tsconfig.server.json'))
  const vitestShared = readFileSync(resolve(repoRoot, 'packages/mcp-server/vitest.shared.ts'), 'utf-8')
  const rootReleaseConfig = readJson(resolve(repoRoot, 'release-please-config.json'))
  const publishedMcpConfig = readJson(resolve(repoRoot, '.mcp.json'))
  const claudePlugin = readJson(resolve(repoRoot, '.claude-plugin/plugin.json'))
  const codexPlugin = readJson(resolve(repoRoot, '.codex-plugin/plugin.json'))
  const registryMetadata = readJson(resolve(repoRoot, 'server.json'))

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
    expect(mcpPackage.main).toBe('./dist/server/mcp/index.js')
    expect(mcpPackage.types).toBe('./dist/server/mcp/index.d.ts')
    expect(mcpPackage.exports).toEqual({
      '.': {
        types: './dist/server/mcp/index.d.ts',
        import: './dist/server/mcp/index.js',
      },
      './package.json': './package.json',
    })
    expect(mcpPackage.homepage).toBeTruthy()
    expect(mcpPackage.bugs?.url).toBeTruthy()
    expect(rootPackage.scripts['test:coverage']).toBe(
      'pnpm --filter @kamiazya/whiteboard-mcp test:coverage',
    )
    expect(mcpPackage.scripts['test:coverage']).toBe(
      'vitest run --coverage --project mcp-node --project mcp-jsdom',
    )
  })

  it('declares sideEffects explicitly for bundlers', () => {
    expect(mcpPackage.sideEffects).toEqual([
      './dist/server/mcp/index.js',
      './dist/app/**/*.css',
    ])
  })

  it('publishes to npm via OIDC trusted publisher (no NPM_TOKEN, with provenance)', () => {
    expect(releaseWorkflow).toContain('Publish to npm')
    expect(releaseWorkflow).toContain('registry-url: https://registry.npmjs.org')
    expect(releaseWorkflow).toContain('pnpm --filter @kamiazya/whiteboard-mcp exec playwright install --with-deps chromium')
    expect(releaseWorkflow).toContain('npm publish --access public --provenance')
    // OIDC trusted publisher requires id-token: write permission and npm >= 11.5.1.
    // Node 24 ships with npm 11.x; relying on the bundled npm avoids the
    // `npm i -g npm@latest` self-upgrade bug.
    expect(releaseWorkflow).toContain('id-token: write')
    expect(releaseWorkflow).toMatch(/node-version:\s*2[4-9]/)
    // Should not fall back to long-lived NPM_TOKEN or GitHub Packages auth.
    expect(releaseWorkflow).not.toContain('Publish to GitHub Packages')
    expect(releaseWorkflow).not.toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}')
    expect(releaseWorkflow).not.toContain('NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
  })

  it('emits declaration files for the published module entrypoint', () => {
    expect(tsconfigServer.compilerOptions.declaration).toBe(true)
  })

  it('documents npm install via the published CLI surface instead of deep dist paths', () => {
    expect(rootReadme).toContain('"command": "npx"')
    expect(rootReadme).toContain('"args": ["-y", "@kamiazya/whiteboard-mcp@latest"]')
    expect(rootReadme).toContain('### Server-only install (`npx`)')
    expect(rootReadme).toContain('### Full install with shared skills')
    expect(rootReadme).toContain('The `npx` path starts the MCP server only. It does not install `/whiteboard` skills.')
    expect(rootReadme).toContain('The only public release artifact today is the npm package `@kamiazya/whiteboard-mcp`.')
    expect(rootReadme).toContain('The committed `.claude-plugin/`, `.codex-plugin/`, and `.mcp.json` files are repo-local wrappers and examples, not separately published release artifacts.')
    expect(rootReadme).toContain('### Link the shared skills')
    expect(rootReadme).toContain('#### Mac / Linux')
    expect(rootReadme).toContain('#### Windows (junction or copy)')
    expect(rootReadme).toContain('$skillRoots = @(')
    expect(rootReadme).toContain('foreach ($root in $skillRoots)')
    expect(rootReadme).toContain('foreach ($skill in $skills)')
    expect(rootReadme).toContain('node_modules/@kamiazya/whiteboard-mcp/skills')
    expect(rootReadme).toContain('command = "npx"')
    expect(rootReadme).toContain('args = ["-y", "@kamiazya/whiteboard-mcp@latest"]')
    expect(rootReadme).not.toContain('node_modules/@kamiazya/whiteboard-mcp/dist/server/mcp/index.js')
  })

  it('explains why dist and skills are both shipped in the npm tarball', () => {
    expect(packageReadme).toContain('## What is in this package')
    expect(packageReadme).toContain('`dist/` contains the runnable MCP server')
    expect(packageReadme).toContain('`skills/` contains the shared skill bundles')
    expect(packageReadme).toContain('The repo-level plugin manifests are not shipped as separate release artifacts.')
  })

  it('keeps published wrappers on @latest so release-please does not need extra-files sync', () => {
    // mcp-server may sync MCP Registry metadata (server.json) but must not pull in
    // any of the wrapper plugin manifests — those stay on @latest.
    const mcpExtras = rootReleaseConfig.packages['packages/mcp-server']['extra-files'] ?? []
    const wrapperPaths = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'packages/mcp-server/.mcp.json']
    for (const wp of wrapperPaths) {
      expect(mcpExtras.some((e) => e.path?.endsWith(wp))).toBe(false)
    }
    expect(publishedMcpConfig.mcpServers.whiteboard).toEqual({
      command: 'npx',
      args: ['-y', '@kamiazya/whiteboard-mcp@latest'],
    })
    expect(claudePlugin.mcpServers.whiteboard).toEqual({
      command: 'npx',
      args: ['-y', '@kamiazya/whiteboard-mcp@latest'],
    })
    expect(codexPlugin.mcpServers).toBe('./.mcp.json')
    expect(contributing).toContain('Keep published MCP wrapper configs on `@latest` unless you also update release-please sync rules.')
  })

  it('keeps MCP Registry metadata present and aligned with the npm package', () => {
    expect(registryMetadata.$schema).toContain('/server.schema.json')
    expect(registryMetadata.name).toBe('io.github.kamiazya/whiteboard')
    expect(registryMetadata.repository).toEqual({
      url: 'https://github.com/kamiazya/whiteboard',
      source: 'github',
    })
    expect(registryMetadata.version).toBe(mcpPackage.version)
    expect(registryMetadata.packages).toEqual([
      {
        registryType: 'npm',
        registryBaseUrl: 'https://registry.npmjs.org',
        identifier: mcpPackage.name,
        version: mcpPackage.version,
        transport: {
          type: 'stdio',
        },
      },
    ])
  })

  it('documents the supported MCP protocol matrix and concrete HTTP debugging steps', () => {
    expect(mcpDebuggingDoc).toContain('## Protocol Support')
    expect(mcpDebuggingDoc).toContain('2025-11-25')
    expect(mcpDebuggingDoc).toContain('2025-06-18')
    expect(mcpDebuggingDoc).toContain('2025-03-26')
    expect(mcpDebuggingDoc).toContain('2024-11-05')
    expect(mcpDebuggingDoc).toContain('2024-10-07')
    expect(mcpDebuggingDoc).toContain('pnpm mcp:http:dev')
    expect(mcpDebuggingDoc).toContain('pnpm mcp:inspect')
    expect(mcpDebuggingDoc).toContain('MCP_HTTP_DEBUG=1 pnpm mcp:http:dev')
    expect(mcpDebuggingDoc).toContain('AGENTS.md')
  })

  it('ships architecture, security, and wire-protocol docs and links them from README', () => {
    expect(rootReadme).toContain('[docs/architecture.md](docs/architecture.md)')
    expect(rootReadme).toContain('[docs/security-model.md](docs/security-model.md)')
    expect(rootReadme).toContain('[docs/wire-protocol.md](docs/wire-protocol.md)')
    expect(architectureDoc).toContain('# Architecture')
    expect(architectureDoc).toContain('stdio MCP server')
    expect(architectureDoc).toContain('daemon')
    expect(architectureDoc).toContain('Loro')
    expect(securityModelDoc).toContain('# Security Model')
    expect(securityModelDoc).toContain('loopback')
    expect(securityModelDoc).toContain('Bearer')
    expect(wireProtocolDoc).toContain('# Wire Protocol')
    expect(wireProtocolDoc).toContain('doc_update')
    expect(wireProtocolDoc).toContain('head_changed')
  })

  it('configures shared Vitest coverage output for local inspection', () => {
    expect(vitestShared).toContain("provider: 'v8'")
    expect(vitestShared).toContain("reporter: ['text', 'html', 'lcov']")
    expect(vitestShared).toContain("reportsDirectory: './tmp/coverage'")
    expect(vitestShared).toContain("include: ['src/**/*.{ts,tsx}']")
    expect(vitestShared).toContain("exclude: ['**/*.test.*', 'src/app/components/ui/**', 'dist/**']")
  })
})
