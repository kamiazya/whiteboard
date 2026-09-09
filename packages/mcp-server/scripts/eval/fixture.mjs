// The seeded workspace every eval task is asked about.
//
// Owned data rather than a live source, so a ground truth cannot drift under
// the eval: every answer in tasks.mjs is true BY CONSTRUCTION of what is
// written here, and `--dry-run` proves the write-task verifiers can tell the
// untouched fixture from a finished one.
//
// Content is written in the product's own terms (notes people would keep,
// boards people would draw) and the questions in tasks.mjs paraphrase it, so
// a task cannot be answered by matching a word in a tool description.

export const WORKSPACE_ID = 'eval'

// OKF Markdown: the frontmatter is the document's core facets, and `type`
// is the one field OKF requires.
const okf = (frontmatter, body) => ['---', ...frontmatter, '---', ...body].join('\n')

export const ONBOARDING = okf(
  ['type: note', 'tags:', '  - process', '  - people'],
  [
    '# Onboarding',
    '',
    'Welcome to the team. This note is the first week in one place.',
    '',
    '## First week',
    '',
    '- Read the [[notes/style-guide]] before opening a pull request.',
    '- Start the daemon once so your browser workspace has somewhere to go.',
    '',
    '## Contacts',
    '',
    'Ask Mika for repository access; ask Ren about the release calendar.',
  ],
)

export const STYLE_GUIDE = okf(
  ['type: note', 'tags:', '  - process'],
  [
    '# Style guide',
    '',
    '## Naming',
    '',
    'A document is a document. A canvas is the spatial surface, never the container.',
    '',
    '## Colours',
    '',
    'Buttons are always teal. Warnings are amber, and nothing else is.',
  ],
)

export const RETRO = okf(
  ['type: note', 'tags:', '  - retro'],
  [
    '# Retrospective, August 2026',
    '',
    '## What went well',
    '',
    'The proposal layer shipped, and the first agent-drawn board was adopted unedited.',
    '',
    '## Action items',
    '',
    '- Move the nightly backup pass into a subprocess (owner: Ren).',
    '- Write down the flake shapes we keep rediscovering (owner: Sora).',
  ],
)

export const MEETING = okf(
  ['type: note', 'tags:', '  - meeting'],
  [
    '# Meeting, 1 September 2026',
    '',
    'Decided: the daemon keeps the workspace and the browser holds a cached replica.',
    'Open: whether the embedding download is acceptable for search.',
  ],
)

/**
 * Seeds the workspace through the real tools and returns the ids the tasks
 * and verifiers address documents by.
 *
 * @param {{ call: (name: string, args: Record<string, unknown>) => Promise<any> }} wb
 */
export async function seed(wb) {
  const created = await wb.call('wb_workspace_edit', {
    workspaceId: WORKSPACE_ID,
    createWorkspace: true,
    actor: 'agent:eval-fixture',
    ops: [
      { op: 'document.create', path: 'notes/onboarding', kind: 'markdown', markdown: ONBOARDING },
      { op: 'document.create', path: 'notes/style-guide', kind: 'markdown', markdown: STYLE_GUIDE },
      { op: 'document.create', path: 'notes/retro-2026-08', kind: 'markdown', markdown: RETRO },
      {
        op: 'document.create',
        path: 'notes/meeting-2026-09-01',
        kind: 'markdown',
        markdown: MEETING,
      },
      { op: 'document.create', path: 'boards/architecture', kind: 'spatial' },
      { op: 'document.create', path: 'boards/roadmap', kind: 'spatial' },
    ],
  })
  const ids = Object.fromEntries(created.results.map((r) => [r.path, r.documentId]))

  const box = (id, text, x, y) => ({
    op: 'node.add',
    node: { id, type: 'text', x, y, width: 200, height: 80, text },
  })
  await wb.call('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId: ids['boards/architecture'],
    mode: 'apply',
    ops: [
      box('browser', 'Browser', 0, 0),
      box('daemon', 'Daemon', 400, 0),
      box('sqlite', 'SQLite', 800, 0),
      box('worker', 'Layout worker', 0, 300),
      {
        op: 'edge.add',
        edge: { id: 'ws', fromNode: 'browser', toNode: 'daemon', label: 'WebSocket' },
      },
      { op: 'edge.add', edge: { id: 'db', fromNode: 'daemon', toNode: 'sqlite', label: 'libsql' } },
      {
        op: 'edge.add',
        edge: { id: 'pm', fromNode: 'browser', toNode: 'worker', label: 'postMessage' },
      },
    ],
  })
  await wb.call('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId: ids['boards/roadmap'],
    mode: 'apply',
    ops: [
      box('q3', 'Q3: proposals', 0, 0),
      box('q4', 'Q4: search v2', 400, 0),
      box('q1', 'Q1: hosted workspaces', 800, 0),
      { op: 'edge.add', edge: { id: 'a', fromNode: 'q3', toNode: 'q4' } },
      { op: 'edge.add', edge: { id: 'b', fromNode: 'q4', toNode: 'q1' } },
    ],
  })
  await wb.call('wb_thread_edit', {
    workspaceId: WORKSPACE_ID,
    documentId: ids['boards/roadmap'],
    ops: [
      {
        op: 'thread.add',
        anchor: { kind: 'spatial', nodeId: 'q4', x: 500, y: 40 },
        body: 'Is a 113MB model download acceptable for search?',
        author: 'person:mika',
      },
    ],
  })

  await wb.call('wb_version_save', {
    workspaceId: WORKSPACE_ID,
    documentIds: [ids['notes/meeting-2026-09-01']],
    label: 'as drafted',
  })
  await wb.call('wb_version_save', {
    workspaceId: WORKSPACE_ID,
    documentIds: [ids['notes/meeting-2026-09-01']],
    label: 'after the meeting',
  })
  await wb.call('wb_version_save', {
    workspaceId: WORKSPACE_ID,
    documentIds: [ids['boards/roadmap'], ids['boards/architecture']],
    label: 'baseline',
  })
  return ids
}
