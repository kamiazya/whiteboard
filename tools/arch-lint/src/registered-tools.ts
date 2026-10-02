import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './scan-roots.js'

/**
 * The registered MCP tool names, read from the list the live server's
 * `tools/list` is held to (`mcp-smoke-coverage.ts`, compared against a real
 * server by the smoke checkpoint) rather than copied here, so prose that
 * enumerates tools is judged against the one list that is held to reality.
 */
export function registeredTools(): string[] {
  const source = readFileSync(
    join(REPO_ROOT, 'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts'),
    'utf-8',
  )
  const body = /export const ALL_REGISTERED_TOOLS = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] as string)
}
