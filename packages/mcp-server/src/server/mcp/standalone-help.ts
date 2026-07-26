export const WHITEBOARD_HELP_URI = 'whiteboard://help/getting-started'
export const WHITEBOARD_DRAW_PROMPT = 'whiteboard.draw_diagram'
export const WHITEBOARD_RECENT_CANVASES_URI = 'whiteboard://state/canvases/recent'

const HELP_LINES = [
  '# Whiteboard MCP quickstart',
  '',
  'Start with `canvas_create` to make a workspace-backed canvas, then draw with `annotate` or `annotate_batch`.',
  '',
  'Suggested loop:',
  '1. `canvas_create` or `canvas_list`',
  '2. `annotate_batch` for boxes/arrows/text in one pass',
  '3. `canvas_inspect` to verify structure',
  '4. `viewport_set` or `canvas_open` when a human needs to review the board',
  '5. `export_canvas({ format: "png" | "svg" })` when you need an artifact',
  '',
  'Common starting points:',
  '- Architecture or flow: `annotate_batch` with boxes and arrows',
  '- Existing board review: `canvas_open`, then `annotate` for comments',
  '- Reusable fragments: `template_list` or `template_insert`',
].join('\n')

export function getStandaloneHelpText(): string {
  return HELP_LINES
}

export function buildDrawDiagramPrompt(goal: string, diagramType?: string): string {
  const typeLine = diagramType
    ? `Target diagram type: ${diagramType}.`
    : 'Choose the most useful diagram type before drawing.'

  return [
    `Create a whiteboard diagram for this goal: ${goal}`,
    typeLine,
    'Start by creating or selecting a canvas, then lay out the main entities or steps with annotate_batch.',
    'Inspect the canvas after each major draw step and export only after the structure is stable.',
  ].join('\n')
}

export function formatRecentCanvasesResource(
  workspaces: Array<{
    workspaceId: string
    canvases: Array<{ id: string; slug: string; updatedAt: string }>
  }>,
): string {
  const canvases = workspaces
    .flatMap((workspace) =>
      workspace.canvases.map((canvas) => ({
        workspaceId: workspace.workspaceId,
        ...canvas,
      })),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 10)

  if (canvases.length === 0) {
    return [
      '# Recent canvases',
      '',
      'No canvases were found in the current workspace set.',
      'Start with `canvas_create` to create one.',
    ].join('\n')
  }

  return [
    '# Recent canvases',
    '',
    ...canvases.map(
      (canvas) =>
        `- ${canvas.id} (slug: ${canvas.slug}, workspace: ${canvas.workspaceId}, updated: ${canvas.updatedAt})`,
    ),
  ].join('\n')
}
