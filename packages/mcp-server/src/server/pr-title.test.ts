import { describe, expect, it } from 'vitest'

import { explainPullRequestTitleRule, isValidPullRequestTitle } from './pr-title.js'

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
})
