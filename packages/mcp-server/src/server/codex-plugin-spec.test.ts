import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('Codex plugin spec contract', () => {
  const pluginRoot = repoRoot
  const codexPluginDir = resolve(pluginRoot, '.codex-plugin')
  const codexPluginPath = resolve(codexPluginDir, 'plugin.json')
  const codexPlugin = readJson(codexPluginPath)

  it('keeps only plugin.json inside .codex-plugin and stores bundled components at the plugin root', () => {
    expect(readdirSync(codexPluginDir)).toEqual(['plugin.json'])
    expect(existsSync(resolve(pluginRoot, '.mcp.json'))).toBe(true)
    expect(existsSync(resolve(pluginRoot, 'skills'))).toBe(true)
  })

  it('uses relative ./ paths for bundled Codex plugin components', () => {
    expect(codexPlugin.skills).toBe('./skills')
    expect(codexPlugin.mcpServers).toBe('./.mcp.json')
    expect(codexPlugin.skills.startsWith('./')).toBe(true)
    expect(codexPlugin.mcpServers.startsWith('./')).toBe(true)
  })

  it('uses a spec-compatible manifest shape for install-surface metadata', () => {
    expect(codexPlugin.name).toMatch(/^[a-z0-9-]+$/)
    expect(codexPlugin.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(codexPlugin.description).toEqual(expect.any(String))
    expect(codexPlugin.repository).toEqual(expect.any(String))
    // Shape only — WHICH license this repo ships is publish-contract.test.ts's
    // 'declares the repo license consistently across every distribution manifest',
    // which derives it from the root package. A literal here pinned 'MIT' in place
    // for the whole life of the Apache-2.0 relicense (#304): the guard meant to
    // check spec compatibility was holding the stale value instead.
    expect(codexPlugin.license).toMatch(/^[\w.+-]+$/)
    expect(codexPlugin.interface).toMatchObject({
      displayName: expect.any(String),
      shortDescription: expect.any(String),
      longDescription: expect.any(String),
      developerName: expect.any(String),
      category: expect.any(String),
      websiteURL: expect.any(String),
    })
    expect(codexPlugin.interface.capabilities).toEqual(expect.arrayContaining(['Read', 'Write']))
  })

  it('points Codex at a published MCP config file with a whiteboard server entry', () => {
    const mcpConfig = readJson(resolve(pluginRoot, codexPlugin.mcpServers))
    const whiteboardServer = mcpConfig.mcpServers?.whiteboard

    expect(whiteboardServer).toMatchObject({
      command: 'npx',
      args: ['-y', '@kamiazya/whiteboard-mcp@latest'],
    })
  })
})
