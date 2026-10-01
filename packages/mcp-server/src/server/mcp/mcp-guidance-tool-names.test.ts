import { describe, expect, it } from 'vitest'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'
import { buildDrawDiagramPrompt, WHITEBOARD_INSTRUCTIONS } from './standalone-help.js'

/**
 * Text this server hands to a client or an agent, where a tool name would be
 * read as an instruction to call it.
 */
const GUIDANCE = [
  { where: 'initialize instructions', text: WHITEBOARD_INSTRUCTIONS },
  { where: 'draw-diagram prompt', text: buildDrawDiagramPrompt('a goal', 'architecture') },
]

/**
 * Anything shaped like one of this server's tool names.
 *
 * Deliberately WIDER than the registered set — matching only registered names
 * would find nothing wrong by construction, which is the whole failure being
 * guarded. `snake_case` with at least one underscore is what every tool this
 * server has ever published looks like, `wb_*` and `canvas_view` alike.
 */
const TOOL_SHAPED = /\b(?:wb|canvas|annotate|export|template|viewport)_[a-z_]+\b/g

const REGISTERED = new Set<string>(ALL_REGISTERED_TOOLS)

/**
 * A tool name in guidance text is an instruction to call it, so it has to be
 * a tool that exists.
 *
 * Renaming a tool leaves its old name behind in every piece of prose that
 * mentioned it, and prose is where nobody looks — correct-looking text in a
 * file no one has reason to reopen. The rule that lasts is not a careful
 * rename: it is that guidance names no tool unless the tool is registered,
 * checked on every run.
 */
describe('MCP guidance text', () => {
  for (const { where, text } of GUIDANCE) {
    it(`names no unregistered tool: ${where}`, () => {
      const unregistered = [...new Set(text.match(TOOL_SHAPED) ?? [])].filter(
        (name) => !REGISTERED.has(name),
      )
      expect(unregistered).toEqual([])
    })
  }

  /**
   * Reached, not assumed. A pattern that stopped matching, or a source file
   * that moved, would report every text as clean — the same shape of silence
   * this file exists to end.
   */
  it('is looking at real text, and the pattern still matches tool names', () => {
    for (const { where, text } of GUIDANCE) {
      expect(text.length, `${where} is empty`).toBeGreaterThan(50)
    }
    expect('wb_workspace_edit canvas_view'.match(TOOL_SHAPED)).toEqual([
      'wb_workspace_edit',
      'canvas_view',
    ])
  })
})
