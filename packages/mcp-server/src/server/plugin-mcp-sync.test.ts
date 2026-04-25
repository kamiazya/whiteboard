// Regression test that detects drift between `.mcp.json` (the published stdio
// config referenced by path) and the inline `mcpServers` field in
// `.claude-plugin/plugin.json`.
//
// Why this exists:
//   - The Codex plugin (`.codex-plugin/plugin.json`) points to `"./.mcp.json"`
//     so it cannot drift.
//   - The Claude Code plugin (`.claude-plugin/plugin.json`) must inline the
//     same content because Claude plugin manifests do not support path refs.
//   - Updating only one of them would split behavior between Claude and Codex
//     at release time.
//
// Verification: read both files and confirm that
// `mcpServers.whiteboard.command` and `.args` match exactly.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf-8')) as T
}

interface McpServerEntry {
  command: string
  args?: string[]
  env?: Record<string, string>
}

describe('plugin manifest mcpServers sync', () => {
  it('keeps the whiteboard server entry in .mcp.json and .claude-plugin/plugin.json in sync', () => {
    const mcpJson = readJson<{ mcpServers: Record<string, McpServerEntry> }>('.mcp.json')
    const claudePlugin = readJson<{ mcpServers: Record<string, McpServerEntry> }>(
      '.claude-plugin/plugin.json',
    )

    expect(mcpJson.mcpServers.whiteboard).toBeDefined()
    expect(claudePlugin.mcpServers.whiteboard).toBeDefined()

    expect(claudePlugin.mcpServers.whiteboard).toEqual(mcpJson.mcpServers.whiteboard)
  })

  it('keeps .codex-plugin/plugin.json pointed at .mcp.json as the single source of truth', () => {
    const codexPlugin = readJson<{ mcpServers: string }>('.codex-plugin/plugin.json')
    expect(codexPlugin.mcpServers).toBe('./.mcp.json')
  })
})
