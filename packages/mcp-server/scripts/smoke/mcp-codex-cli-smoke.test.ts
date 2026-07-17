import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('mcp-codex-cli-smoke.mjs', () => {
  it('exits 0 with a SKIP message when the codex CLI is absent from PATH', () => {
    const scriptPath = resolve(import.meta.dirname, 'mcp-codex-cli-smoke.mjs')

    const result = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, PATH: '' },
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[codex-smoke] SKIP')
  })
})
