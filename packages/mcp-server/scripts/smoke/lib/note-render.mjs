/**
 * `wb_scene_render` of a MARKDOWN document through the daemon as it ships: a
 * note embedding a board, rendered whole with its references (the board's
 * box drawn inside the note), by one heading's section (the prose before it
 * left out), and refused by name for a heading the note does not hold. The
 * layout is the core's markdown entry under `WHITEBOARD_CORE_LAYOUT`, so
 * running the smoke with it at `differential` and mismatches thrown compares
 * every one of these with the TypeScript.
 */
export async function noteRenderDrawsItsBoardAndSection({
  callTool,
  expectToolError,
  workspaceId,
}) {
  const created = await callTool('wb_workspace_edit', {
    workspaceId,
    ops: [
      { op: 'document.create', path: 'e2e-note-board', kind: 'spatial' },
      {
        op: 'document.create',
        path: 'e2e-note',
        kind: 'markdown',
        markdown: '# Intro\n\nOpening words.\n\n## Board\n\n![[e2e-note-board]]\n',
      },
    ],
  })
  const [board, note] = created.results
  if (board?.documentId === undefined || note?.documentId === undefined) {
    throw new Error(`wb_workspace_edit created no note and board: ${JSON.stringify(created)}`)
  }
  await callTool('wb_canvas_edit', {
    workspaceId,
    documentId: board.documentId,
    mode: 'apply',
    ops: [
      {
        op: 'node.add',
        node: { id: 'b', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'embedded box' },
      },
    ],
  })
  const whole = await callTool('wb_scene_render', {
    workspaceId,
    documentId: note.documentId,
    embedReferences: true,
  })
  if (!whole.svg.includes('Opening words') || !whole.svg.includes('embedded box')) {
    throw new Error('wb_scene_render of a note did not draw its prose and its embedded board')
  }
  const section = await callTool('wb_scene_render', {
    workspaceId,
    documentId: note.documentId,
    embedReferences: true,
    fragment: 'Board',
  })
  if (section.svg.includes('Opening words') || !section.svg.includes('embedded box')) {
    throw new Error('wb_scene_render of a note section drew more or less than the section')
  }
  await expectToolError(
    'wb_scene_render',
    { workspaceId, documentId: note.documentId, fragment: 'Nowhere' },
    'with a heading the note does not hold',
    'has no heading "Nowhere"',
  )
  console.log(
    '[e2e] wb_scene_render → a note draws its embedded board, one section alone, and refuses a missing heading',
  )
}
