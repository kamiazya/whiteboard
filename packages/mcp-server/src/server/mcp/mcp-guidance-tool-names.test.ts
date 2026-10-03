import { describe, expect, it } from 'vitest'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'
import { buildDrawDiagramPrompt, WHITEBOARD_INSTRUCTIONS } from './standalone-help.js'
import { TOOL_PROFILES } from './tool-profiles.js'

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

/**
 * The draw-diagram prompt is the "a person just asked you to draw" case, and
 * `wb_canvas_edit` stores a default-mode batch as a proposal nobody sees. A
 * prompt that never says `apply` sends the agent into a drawing that stays
 * empty on screen; one that says to read back or to export contradicts the
 * tool's own description (the result carries the board) and names a step that
 * has no tool behind it.
 */
describe('draw-diagram prompt', () => {
  const prompt = buildDrawDiagramPrompt('a goal', 'architecture')

  it('says to write with mode "apply", since a default write is a proposal', () => {
    expect(prompt).toContain('wb_canvas_edit')
    expect(prompt).toContain('mode: "apply"')
  })

  it('does not ask for a read-back the edit result already carries, nor an export no tool offers', () => {
    expect(prompt).not.toMatch(/read the document back/i)
    expect(prompt).not.toMatch(/\bexport\b/i)
  })

  it('names the one render tool', () => {
    expect(prompt).toContain('wb_scene_render')
  })
})

/**
 * A title is read beside the description and says less, so one that names a
 * single arm of a multi-arm tool teaches a model the others do not exist.
 */
describe('TOOL_PROFILES titles of the facet tools', () => {
  it('wb_facet_set names tags, facets, and every object they reach', () => {
    const title = TOOL_PROFILES.wb_facet_set?.title ?? ''
    for (const word of [/tag/i, /facet/i, /document/i, /canvas/i, /node/i, /edge/i]) {
      expect(title, `"${title}" misses ${word}`).toMatch(word)
    }
    expect(title).not.toMatch(/frontmatter/i)
  })

  it('wb_facet_list names the registry, stencils, tags in use and the tag library', () => {
    const title = TOOL_PROFILES.wb_facet_list?.title ?? ''
    for (const word of [/facet/i, /stencil/i, /tags in use/i, /tag library/i]) {
      expect(title, `"${title}" misses ${word}`).toMatch(word)
    }
  })
})
