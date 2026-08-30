// What this server tells a client about itself, and where.
//
// MCP has a dedicated channel for this: `instructions` on the initialize
// result, which a client injects into the model's system prompt. That is
// what this file supplies now.
//
// It used to serve a `whiteboard://help/getting-started` RESOURCE instead,
// described as "standalone help for raw MCP clients that do not load
// Claude/Codex skills" — the exact audience `instructions` exists for, over a
// channel no client is obliged to read. Nothing forces a client to fetch a
// resource, so the audience most likely to need the help was the least likely
// to see it.
//
// It also carried a hand-written list of ten tool names, and by the time it
// was read again NOT ONE of them was registered: `canvas_create`, `annotate`,
// `annotate_batch`, `canvas_inspect`, `viewport_set`, `canvas_open`,
// `export_canvas`, `template_list`, `template_insert`, `canvas_list`. The
// tools had been renamed to `wb_*` by ADR-0009 and the templates feature
// deleted outright. An agent following this text called ten tools that do not
// exist, and nothing anywhere noticed.
//
// So the text below names NO individual tool, deliberately. That is also the
// documented practice: instructions carry the CROSS-CUTTING context a
// per-tool description cannot, and must not be the only thing making a tool
// usable — "if a client ignores instructions, each tool should still be
// usable from its own description and schema alone". A second list of tool
// names is a second thing to keep in step, and this file is what happens when
// nobody does. `mcp-guidance-tool-names.test.ts` holds the line.

export const WHITEBOARD_DRAW_PROMPT = 'whiteboard.draw_diagram'

/**
 * Cross-cutting orientation, handed to the client at initialize.
 *
 * Shape, not steps: which entities exist, what a document's kind decides, and
 * where the durable ids live. What each tool takes and returns is its own
 * description's job.
 */
export const WHITEBOARD_INSTRUCTIONS = [
  'Whiteboard keeps DOCUMENTS in a WORKSPACE. A document has a kind — a spatial',
  'canvas or a markdown document — and its kind decides how it can be read and',
  'written; there is no reading one as the other.',
  '',
  'A workspace owns placement and naming; a document owns its content. Address a',
  'document by the path its workspace gives it, and keep the canonical id when you',
  'need a reference that survives a rename.',
  '',
  'Edits are versioned: a document can be saved as a version and restored to one.',
  'Prefer one batched edit over many single ones — the tools that take a batch say',
  'so, and each call is a round trip through storage.',
  '',
  'Anything a human is meant to look at needs rendering or opening explicitly;',
  'writing to a document does not put it on anyone screen.',
].join('\n')

export function buildDrawDiagramPrompt(goal: string, diagramType?: string): string {
  const typeLine = diagramType
    ? `Target diagram type: ${diagramType}.`
    : 'Choose the most useful diagram type before drawing.'

  // Names no tool either, and for the same reason: this text is handed to a
  // model that can already see the tool list, so naming tools here only adds
  // a second place for those names to go stale.
  return [
    `Create a whiteboard diagram for this goal: ${goal}`,
    typeLine,
    'Create or select a spatial document first, then lay out the main entities or',
    'steps in as few batched edits as the tools allow.',
    'Read the document back after each major change, and render or export only once',
    'the structure is stable.',
  ].join('\n')
}
