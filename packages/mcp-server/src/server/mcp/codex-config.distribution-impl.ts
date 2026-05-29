import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { runE2eCheckpointSmoke } from './mcp-e2e-checkpoint.smoke-impl.js'

interface RunCodexConfigSmokeOptions {
  packageRoot: string
  repoRoot: string
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

export async function runCodexConfigSmoke({
  packageRoot,
  repoRoot,
}: RunCodexConfigSmokeOptions): Promise<void> {
  const pluginPath = resolve(repoRoot, '.codex-plugin/plugin.json')
  if (!existsSync(pluginPath)) {
    throw new Error(`[codex-config-smoke] missing plugin manifest: ${pluginPath}`)
  }

  const plugin = readJson(pluginPath) as {
    name?: unknown
    skills?: unknown
    mcpServers?: unknown
  }

  if (plugin.name !== 'whiteboard') {
    throw new Error(`[codex-config-smoke] unexpected plugin name: ${plugin.name}`)
  }

  if (typeof plugin.skills !== 'string') {
    throw new Error('[codex-config-smoke] plugin.skills must be a string path')
  }
  const skillsPath = resolve(repoRoot, plugin.skills)
  if (!existsSync(skillsPath)) {
    throw new Error(`[codex-config-smoke] plugin skills path does not exist: ${skillsPath}`)
  }

  if (typeof plugin.mcpServers !== 'string') {
    throw new Error(
      '[codex-config-smoke] plugin.mcpServers must be a string path to the published MCP config',
    )
  }
  const mcpConfigPath = resolve(repoRoot, plugin.mcpServers)
  if (!existsSync(mcpConfigPath)) {
    throw new Error(`[codex-config-smoke] plugin mcpServers path does not exist: ${mcpConfigPath}`)
  }

  const mcpConfig = readJson(mcpConfigPath) as {
    mcpServers?: { whiteboard?: { command?: unknown; args?: unknown } }
  }
  const whiteboardServer = mcpConfig.mcpServers?.whiteboard
  if (!whiteboardServer) {
    throw new Error('[codex-config-smoke] missing mcpServers.whiteboard in published MCP config')
  }

  if (whiteboardServer.command !== 'npx') {
    throw new Error(
      `[codex-config-smoke] expected published Codex MCP command to be "npx", got: ${whiteboardServer.command}`,
    )
  }

  const expectedArgs = JSON.stringify(['-y', '@kamiazya/whiteboard-mcp@latest'])
  if (JSON.stringify(whiteboardServer.args) !== expectedArgs) {
    throw new Error(
      `[codex-config-smoke] expected published Codex MCP args ${expectedArgs}, got: ${JSON.stringify(whiteboardServer.args)}`,
    )
  }

  console.log(`[codex-config-smoke] plugin → ${pluginPath}`)
  console.log(`[codex-config-smoke] skills → ${skillsPath}`)
  console.log(`[codex-config-smoke] published mcp config → ${mcpConfigPath}`)
  console.log('[codex-config-smoke] published config is wired to npx @kamiazya/whiteboard-mcp@latest')

  const entry = resolve(packageRoot, 'dist/server/mcp/index.js')
  if (!existsSync(entry)) {
    throw new Error(
      `[codex-config-smoke] dist artifact missing: ${entry}\nRun pnpm build before mcp-distribution tests.`,
    )
  }

  await runE2eCheckpointSmoke({ entry, root: packageRoot })
}
