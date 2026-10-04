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
  'A workspace owns placement and naming; a document owns its content. Tools that',
  'read or change a document take its documentId, which the workspace tools return',
  'and which survives a rename. A path is where a document is placed (on create',
  'or move) and how a link names one; a tool that wants a documentId refuses a path.',
  '',
  'A fresh data directory holds one workspace, `default`, and it is the one the',
  'whiteboard app opens first: address it as `default` unless you were given',
  'another handle.',
  '',
  'A markdown body links to another document with [[path]] and embeds it with',
  '![[path]]; add #Heading (for a markdown target) or #Group label (for a canvas)',
  'to point at one part of it. A render shows an embed as its address unless',
  '`embedReferences` is set, which draws what the document embeds; a render can',
  'also take one part on its own.',
  '',
  'Edits are versioned: a document can be saved as a version and restored to one.',
  'Prefer one batched edit over many single ones — the tools that take a batch say',
  'so, and each call is a round trip through storage.',
  '',
  'Anything a human is meant to look at needs rendering or opening explicitly.',
  'A write reaches an app that already shows the document only while the',
  'whiteboard daemon runs; without one, nobody sees it until it is rendered or',
  'opened.',
  '',
  'On a canvas, boxes need room between them: under about 32px two boxes read as',
  'one shape and an edge between them has nowhere to put its label. To put a box',
  'between two others, move the neighbours over in the same batch rather than',
  'shrinking the box or squeezing it into the gap. A box meant to sit in a row',
  'or column with others shares their exact x or y; when adding beside existing',
  'boxes, end the batch with a tidy op scoped to the boxes you added, which',
  'lines up one that is a few pixels off and keeps the gaps.',
].join('\n')

export function buildDrawDiagramPrompt(goal: string, diagramType?: string): string {
  const typeLine = diagramType
    ? `Target diagram type: ${diagramType}.`
    : 'Choose the most useful diagram type before drawing.'

  // Unlike the instructions above, this names the two tools it routes through:
  // a person asked for a drawing, and `wb_canvas_edit`'s default mode stores a
  // batch as a proposal nobody sees, so the one parameter that makes the drawing
  // appear has to be said here. mcp-guidance-tool-names.test.ts holds every
  // name to the registered set.
  return [
    `Create a whiteboard diagram for this goal: ${goal}`,
    typeLine,
    'Create or select a spatial document first, then lay out the main entities or',
    'steps in one batched wb_canvas_edit with mode: "apply" — a default-mode write',
    'is stored as a proposal that does not change the board. Its result already',
    'shows the resulting board, so there is no need to read it again; render it with',
    'wb_scene_render once the structure is stable.',
  ].join('\n')
}
