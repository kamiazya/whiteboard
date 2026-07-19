// The root README/docs (docs/contributing/development.md) document `pnpm dev`
// as starting Vite and the MCP server together. Before this test existed, the
// root `dev` script only launched the MCP server (`pnpm --filter
// @kamiazya/whiteboard-mcp dev`), so a first-time contributor following the
// docs never saw the web UI come up. This test pins the documented behavior
// to the actual script contents so the two cannot drift again.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname -> packages/mcp-server/src/server/release
const REPO_ROOT = resolve(__dirname, '../../../../..')
const rootPackage = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
  scripts?: Record<string, string>
}

describe('root package.json dev script', () => {
  it('starts both the web app dev server and the MCP server dev watch', () => {
    const devScript = rootPackage.scripts?.dev ?? ''
    expect(devScript).toContain('@kamiazya/whiteboard-web')
    expect(devScript).toContain('@kamiazya/whiteboard-mcp')
  })
})
