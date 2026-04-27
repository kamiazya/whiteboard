import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('plugin support packaging', () => {
  const rootPackage = readJson(resolve(repoRoot, 'package.json'))
  const mcpPackage = readJson(resolve(repoRoot, 'packages/mcp-server/package.json'))
  const claudePlugin = readJson(resolve(repoRoot, '.claude-plugin/plugin.json'))
  const releasePlease = readJson(resolve(repoRoot, 'release-please-config.json'))

  it('ships shared skills with the MCP package', () => {
    expect(mcpPackage.files).toContain('dist')
    expect(mcpPackage.files).toContain('skills')
  })

  it('includes a Codex plugin manifest wired to the shared skills and MCP config', () => {
    const codexPlugin = readJson(resolve(repoRoot, '.codex-plugin/plugin.json'))

    expect(codexPlugin.name).toBe('whiteboard')
    expect(codexPlugin.skills).toBe('./skills')
    expect(codexPlugin.mcpServers).toBe('./.mcp.json')
  })

  it('provides a plugin-local MCP config for Codex', () => {
    const codexMcpConfig = readJson(resolve(repoRoot, '.mcp.json'))
    const whiteboardServer = codexMcpConfig.mcpServers?.whiteboard

    expect(whiteboardServer).toBeDefined()
    expect(whiteboardServer.command).toBe('npx')
    expect(whiteboardServer.args).toEqual(['-y', '@kamiazya/whiteboard-mcp@latest'])
  })

  it('keeps Claude, Codex, and Gemini plugin manifests on the root release version track', () => {
    const codexPlugin = readJson(resolve(repoRoot, '.codex-plugin/plugin.json'))
    const geminiExtension = readJson(resolve(repoRoot, 'gemini-extension.json'))
    const syncedPaths = releasePlease.packages['.']['extra-files'].map(
      (entry: { path: string }) => entry.path,
    )

    expect(claudePlugin.version).toBe(rootPackage.version)
    expect(codexPlugin.version).toBe(rootPackage.version)
    expect(geminiExtension.version).toBe(rootPackage.version)
    expect(syncedPaths).toContain('.claude-plugin/plugin.json')
    expect(syncedPaths).toContain('.codex-plugin/plugin.json')
    expect(syncedPaths).toContain('gemini-extension.json')
  })
})
