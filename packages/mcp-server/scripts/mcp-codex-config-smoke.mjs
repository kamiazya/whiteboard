#!/usr/bin/env node
// Smoke test for the Codex plugin manifest and .mcp.json loading path without
// consuming API quota.
//
// Purpose:
// - Verify `.codex-plugin/plugin.json` points to the shared skills and `.mcp.json`
// - Verify the published `.mcp.json` config uses the expected npx shape
// - Verify the built release entrypoint (`dist/server/mcp/index.js`) can start
//
// A real Codex CLI subprocess requires quota and is too heavy for the release
// gate, so this reads the public config surface and then delegates to packaged
// smoke coverage.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '..')
const repoRoot = resolve(packageRoot, '../..')

function fail(message) {
  console.error(`[codex-config-smoke] FAIL: ${message}`)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

const pluginPath = resolve(repoRoot, '.codex-plugin/plugin.json')
if (!existsSync(pluginPath)) fail(`missing plugin manifest: ${pluginPath}`)

const plugin = readJson(pluginPath)
if (plugin.name !== 'whiteboard') fail(`unexpected plugin name: ${plugin.name}`)

if (typeof plugin.skills !== 'string') {
  fail('plugin.skills must be a string path')
}
const skillsPath = resolve(repoRoot, plugin.skills)
if (!existsSync(skillsPath)) {
  fail(`plugin skills path does not exist: ${skillsPath}`)
}

if (typeof plugin.mcpServers !== 'string') {
  fail('plugin.mcpServers must be a string path to the published MCP config')
}
const mcpConfigPath = resolve(repoRoot, plugin.mcpServers)
if (!existsSync(mcpConfigPath)) {
  fail(`plugin mcpServers path does not exist: ${mcpConfigPath}`)
}

const mcpConfig = readJson(mcpConfigPath)
const whiteboardServer = mcpConfig.mcpServers?.whiteboard
if (!whiteboardServer) fail('missing mcpServers.whiteboard in published MCP config')

if (whiteboardServer.command !== 'npx') {
  fail(`expected published Codex MCP command to be "npx", got: ${whiteboardServer.command}`)
}

const expectedArgs = JSON.stringify(['-y', '@kamiazya/whiteboard-mcp@latest'])
if (JSON.stringify(whiteboardServer.args) !== expectedArgs) {
  fail(
    `expected published Codex MCP args ${expectedArgs}, got: ${JSON.stringify(whiteboardServer.args)}`,
  )
}

console.log(`[codex-config-smoke] plugin → ${pluginPath}`)
console.log(`[codex-config-smoke] skills → ${skillsPath}`)
console.log(`[codex-config-smoke] published mcp config → ${mcpConfigPath}`)
console.log('[codex-config-smoke] published config is wired to npx @kamiazya/whiteboard-mcp@latest')

const child = spawn(
  'node',
  ['scripts/mcp-e2e-checkpoint.mjs', '--entry=dist/server/mcp/index.js'],
  {
    cwd: packageRoot,
    stdio: 'inherit',
  },
)

child.on('exit', (code, signal) => {
  if (signal) {
    fail(`delegated packaged smoke exited via signal: ${signal}`)
  }
  process.exit(code ?? 1)
})
