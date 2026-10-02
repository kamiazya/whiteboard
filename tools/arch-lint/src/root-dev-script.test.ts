// docs/contributing/development.md documents `pnpm dev` as starting the web
// app (Vite) and the MCP server together. Pin that documented behavior to the
// actual script so the two cannot drift.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

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
