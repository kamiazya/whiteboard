import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// The script CI runs, not a copy of it: pr-title.yml executes this file.
import {
  explainPullRequestTitleRule,
  isValidPullRequestTitle,
} from '../../../../tools/check-pr-title.mjs'
import { repoRoot } from '../shared/test-utils/repo-root.js'

const SCRIPT = join(repoRoot(), 'tools/check-pr-title.mjs')

function runScript(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
}

describe('pull request title validation', () => {
  it('accepts Conventional Commit titles that survive squash merge into release-please', () => {
    expect(isValidPullRequestTitle('fix: harden MCP release and dev workflows')).toBe(true)
    expect(isValidPullRequestTitle('feat(mcp): add remote metadata endpoint')).toBe(true)
    expect(isValidPullRequestTitle('chore(main): release v0.0.3')).toBe(true)
    expect(isValidPullRequestTitle('chore(main): release mcp-server v0.0.3')).toBe(true)
  })

  it('rejects human-only or tool-prefixed PR titles', () => {
    expect(isValidPullRequestTitle('Harden MCP release and dev workflows')).toBe(false)
    expect(isValidPullRequestTitle('[codex] Harden MCP release and dev workflows')).toBe(false)
    expect(isValidPullRequestTitle('release mcp-server v0.0.3')).toBe(false)
  })

  it('explains the accepted rule in one line for CI errors', () => {
    expect(explainPullRequestTitleRule()).toContain('Conventional Commits')
    expect(explainPullRequestTitleRule()).toContain('fix:')
    expect(explainPullRequestTitleRule()).toContain('chore(main): release')
  })

  it('exits 0 and says so for a valid title when run as the CI script', () => {
    const result = runScript('fix: harden MCP release and dev workflows')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PR title OK: fix: harden MCP release and dev workflows')
  })

  it('exits 1 with the rule explained for an invalid title when run as the CI script', () => {
    const result = runScript('[codex] Harden MCP release and dev workflows')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Invalid PR title')
    expect(result.stderr).toContain('Conventional Commits')
  })

  it('exits 1 when no title is given', () => {
    const result = runScript()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Missing PR title')
  })
})
