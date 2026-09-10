// A real MCP client over stdio to a whiteboard server running from source,
// used to SEED the fixture workspace and to READ state back after an agent
// has worked on it. The SDK validates every payload, so the fixture cannot
// drift from the schemas silently.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const here = dirname(fileURLToPath(import.meta.url))
export const LAUNCHER = resolve(here, 'server-launcher.mjs')

/** @param {string} dataDir */
export function serverSpec(dataDir) {
  return {
    command: process.execPath,
    args: [LAUNCHER],
    env: { ...process.env, WHITEBOARD_DATA_DIR: dataDir, WHITEBOARD_NO_WATCH: '1' },
  }
}

/**
 * @param {string} dataDir
 * @returns {Promise<{ call: (name: string, args: Record<string, unknown>) => Promise<any>, close: () => Promise<void> }>}
 */
export async function connectWhiteboard(dataDir) {
  const spec = serverSpec(dataDir)
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: spec.env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'tool-surface-eval', version: '0.0.0' })
  await client.connect(transport)
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args })
      if (result.isError) {
        const text = result.content?.find((block) => block.type === 'text')?.text ?? ''
        throw new Error(`${name} refused: ${text}`)
      }
      return result.structuredContent
    },
    async close() {
      await client.close()
    },
  }
}
