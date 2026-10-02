import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('plugin support packaging', () => {
  const rootPackage = readJson(resolve(REPO_ROOT, 'package.json'))
  const mcpPackage = readJson(resolve(REPO_ROOT, 'packages/mcp-server/package.json'))
  const claudePlugin = readJson(resolve(REPO_ROOT, '.claude-plugin/plugin.json'))
  const releasePlease = readJson(resolve(REPO_ROOT, 'release-please-config.json'))

  it('ships dist but deliberately NOT skills in the npm package', () => {
    // Skills distribute through the plugin (repo-root skills/); nothing in
    // the published server reads a packaged skills/ directory, so a files
    // entry for it was a false claim — pinned absent.
    expect(mcpPackage.files).toContain('dist')
    expect(mcpPackage.files).not.toContain('skills')
  })

  it('includes a Codex plugin manifest wired to the shared skills and MCP config', () => {
    const codexPlugin = readJson(resolve(REPO_ROOT, '.codex-plugin/plugin.json'))

    expect(codexPlugin.name).toBe('whiteboard')
    expect(codexPlugin.skills).toBe('./skills')
    expect(codexPlugin.mcpServers).toBe('./.mcp.json')
  })

  it('provides a plugin-local MCP config for Codex', () => {
    const codexMcpConfig = readJson(resolve(REPO_ROOT, '.mcp.json'))
    const whiteboardServer = codexMcpConfig.mcpServers?.whiteboard

    expect(whiteboardServer).toBeDefined()
    expect(whiteboardServer.command).toBe('npx')
    expect(whiteboardServer.args).toEqual(['-y', '@kamiazya/whiteboard-mcp@latest'])
  })

  it('keeps Claude, Codex, and Gemini plugin manifests on the root release version track', () => {
    const codexPlugin = readJson(resolve(REPO_ROOT, '.codex-plugin/plugin.json'))
    const geminiExtension = readJson(resolve(REPO_ROOT, 'gemini-extension.json'))
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
