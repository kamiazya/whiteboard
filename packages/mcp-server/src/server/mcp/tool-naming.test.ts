import { describe, expect, it } from 'vitest'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'
import { TOOL_PROFILES } from './tool-profiles.js'

/**
 * ADR-0009 fixes every data-plane tool at `wb_<entity>_<action>`.
 *
 * This checks the SHAPE of each name rather than comparing two lists.
 * The existing guards — the smoke's `tools/list` vs ALL_REGISTERED_TOOLS,
 * and the category-coverage property — both compare one list against
 * another, so a systematic error applied to both sides passes them. A
 * repo-wide rename that produced `wb_wb_facet_set` everywhere did exactly
 * that: consistent, and wrong. These assertions are independent statements
 * about a single name, which is what that class of mistake needs.
 */

const ENTITIES = [
  'body',
  'canvas',
  'document',
  'edge',
  'facet',
  'node',
  'scene',
  'version',
] as const

/**
 * Deliberately still on their pre-ADR-0009 names. They collapse into one
 * `wb_document_get` that branches on the document's format, and the
 * OpenCanvas document persists no format to branch on — see ADR-0009's
 * Consequences. Emptying this list is part of that work, not a separate
 * cleanup: once the format exists these two stop existing.
 */
const PENDING_FORMAT_MERGE = ['canvas_export_json_canvas', 'canvas_export_okf'] as const

describe('ADR-0009 tool naming', () => {
  it('the pending list names tools that are actually registered', () => {
    // Otherwise a rename could empty this list by accident and the
    // exemption would outlive the tools it excuses.
    for (const name of PENDING_FORMAT_MERGE) {
      expect(ALL_REGISTERED_TOOLS, `${name} is exempted but not registered`).toContain(name)
    }
  })

  it.each(
    ALL_REGISTERED_TOOLS.filter((n) => !PENDING_FORMAT_MERGE.includes(n as never)),
  )('%s is wb_<entity>_<action>', (name) => {
    const match = /^wb_([a-z]+)_([a-z_]+)$/.exec(name)
    expect(match, `${name} is not wb_<entity>_<action>`).not.toBeNull()

    const entity = match?.[1]
    expect(ENTITIES, `${name} names an entity ADR-0009 does not define`).toContain(entity)

    // The doubled-prefix case is worth its own assertion rather than being
    // left to the regex: `wb_wb_facet_set` parses as entity `wb`, and a
    // reader debugging that would rather be told the prefix repeated.
    expect(name.startsWith('wb_wb_'), `${name} repeats the wb_ prefix`).toBe(false)
  })

  it('TOOL_PROFILES covers exactly the registered tools', () => {
    // Not a restatement of the smoke's check: that one compares tools/list
    // against ALL_REGISTERED_TOOLS. A tool can be registered and still have
    // no profile, which silently downgrades it to MUTATING with the name as
    // its title — the one piece of human-readable metadata a client sees.
    expect(Object.keys(TOOL_PROFILES).sort()).toEqual([...ALL_REGISTERED_TOOLS].sort())
  })
})
