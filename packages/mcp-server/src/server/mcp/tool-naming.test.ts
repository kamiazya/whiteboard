import { describe, expect, it } from 'vitest'
import { ALL_REGISTERED_TOOLS, UI_LINKED_TOOLS } from './mcp-smoke-coverage.js'
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
  // Added by ADR-0010. Not a document-model noun like the rest — a viewport
  // belongs to a client, not to stored content — but `wb_viewport_set` is
  // still an agent asking the DAEMON to do something, which is what the
  // `wb_` plane is. ADR-0009 point 7's exemption does not apply: that one is
  // for tools the MCP Apps HOST renders (`canvas_view`, `canvas_open`), and
  // this one talks to the daemon's own WebSocket clients.
  'viewport',
  'version',
  // ADR-0009's own table stops at the nouns a document is made of, because
  // every tool it renamed acted on ONE document. The workspace was already
  // the entity that owns placement and naming (`vocabulary.md`), it simply
  // had no tool of its own until a batch needed a subject: `wb_workspace_edit`
  // applies an ordered list of operations to the tree, not to any one
  // document in it, so `document` would be the wrong noun rather than a
  // shorter one.
  'workspace',
] as const

/**
 * Empty, and kept that way on purpose. It held the two exporters that
 * ADR-0009 could not rename until a document recorded its own format;
 * wb_document_get replaced them once one did. A future tool that cannot
 * take its final name yet goes here WITH its reason, rather than being
 * quietly excluded from the shape check.
 */
const PENDING_FORMAT_MERGE = [] as const

/**
 * MCP Apps UI tools are exempt from the `wb_` scheme by ADR-0009 point 7:
 * `canvas_open` and `canvas_view` are a UI contract with the MCP Apps host,
 * not part of this data plane. Read from UI_LINKED_TOOLS rather than
 * restated here, so the exemption and the linkage guard cannot disagree
 * about which tools are UI tools.
 */

describe('ADR-0009 tool naming', () => {
  it('the pending list names tools that are actually registered', () => {
    // Otherwise a rename could empty this list by accident and the
    // exemption would outlive the tools it excuses.
    for (const name of PENDING_FORMAT_MERGE) {
      expect(ALL_REGISTERED_TOOLS, `${name} is exempted but not registered`).toContain(name)
    }
  })

  it('the UI-linked exemption names tools that are actually registered', () => {
    // Same reason as the pending list above: an exemption must not outlive
    // the tool it excuses.
    for (const name of UI_LINKED_TOOLS) {
      expect(ALL_REGISTERED_TOOLS, `${name} is exempted but not registered`).toContain(name)
    }
  })

  it.each(
    ALL_REGISTERED_TOOLS.filter(
      (n) => !PENDING_FORMAT_MERGE.includes(n as never) && !UI_LINKED_TOOLS.includes(n as never),
    ),
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
