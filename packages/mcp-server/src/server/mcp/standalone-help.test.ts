import { describe, expect, it } from 'vitest'
import { WHITEBOARD_INSTRUCTIONS } from './standalone-help.js'

describe('WHITEBOARD_INSTRUCTIONS', () => {
  // No tool lists workspaces and an MCP-only install has no skill to name one,
  // so this is the one channel that can say where a first document goes.
  it('names the workspace a fresh daemon holds first', () => {
    expect(WHITEBOARD_INSTRUCTIONS).toMatch(/workspace[^.]*\bdefault\b/i)
  })

  // A write reaches an app that is showing the document only while the daemon
  // runs; stating it flatly either way is false for one of the two installs.
  it('says a write is seen live only with a daemon, and never that it is seen never', () => {
    expect(WHITEBOARD_INSTRUCTIONS).toMatch(/daemon/)
    expect(WHITEBOARD_INSTRUCTIONS).not.toContain('does not put it on')
  })

  it('spells its possessives', () => {
    expect(WHITEBOARD_INSTRUCTIONS).not.toMatch(/\banyone screen\b/)
  })
})
