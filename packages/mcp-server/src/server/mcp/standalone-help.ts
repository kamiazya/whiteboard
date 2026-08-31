// What this server tells a client about itself, and where.
//
// MCP's channel for it is `instructions` on the initialize result, which a
// client injects into the model's system prompt. A help RESOURCE is not: no
// client is obliged to read one, so the reader most likely to need it is the
// least likely to see it.
//
// The text below names NO individual tool, deliberately. Instructions carry
// the CROSS-CUTTING context a per-tool description cannot, and must not be
// what makes a tool usable — a client that ignores them should still be able
// to use every tool from its own description and schema alone. Naming tools
// here would add a second list to keep in step with the registrations, and
// nothing reads prose to check it. `mcp-guidance-tool-names.test.ts` holds
// the line.

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

  // Names no tool either, and for the same reason: the model reading this can
  // already see the tool list.
  return [
    `Create a whiteboard diagram for this goal: ${goal}`,
    typeLine,
    'Create or select a spatial document first, then lay out the main entities or',
    'steps in as few batched edits as the tools allow.',
    'Read the document back after each major change, and render or export only once',
    'the structure is stable.',
  ].join('\n')
}
