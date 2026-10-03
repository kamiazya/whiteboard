// The widget's own call builder: a refresh sends what the widget sends.
import { canvasViewCall } from '@kamiazya/whiteboard-canvas-viewer/widget-tool-calls'

/**
 * `canvas_view` names the theme's font for the widget and keeps naming it
 * across the widget's Refresh.
 *
 * The widget draws in a bundled family unless it can measure the one the
 * theme names, and it has no catalogue of its own — so the tool answers
 * where that family lives. Only the ANSWER travels: a URL, never the 4 MB
 * behind it. The SDK validates it against canvasViewOutputSchema, which is
 * the point of doing it here. The refresh is built from what the first result
 * echoed, because a call naming no style is answered in the bundled look and
 * the themed canvas would turn clean.
 */
export async function canvasViewDrawsTheThemeAndKeepsItOnRefresh(
  callTool,
  workspaceId,
  documentId,
) {
  await callTool('wb_facet_set', {
    workspaceId,
    documentIds: [documentId],
    target: 'canvas',
    facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
  })
  const sketched = await callTool('canvas_view', { workspaceId, documentId, style: 'document' })
  if (sketched.themeFont?.family !== 'Yomogi') {
    throw new Error(`canvas_view named no theme font: ${JSON.stringify(sketched.themeFont)}`)
  }
  if (!sketched.themeFont.url.startsWith('https://raw.githubusercontent.com/')) {
    throw new Error(
      `canvas_view's theme font URL left the catalogue origin: ${sketched.themeFont.url}`,
    )
  }
  const refresh = canvasViewCall({ workspaceId, documentId, style: sketched.style })
  const refreshed = await callTool(refresh.name, refresh.arguments)
  if (refreshed.style !== 'document' || refreshed.themeFont?.family !== 'Yomogi') {
    throw new Error(
      `the widget's refresh lost the theme: ${JSON.stringify({ style: refreshed.style, themeFont: refreshed.themeFont })}`,
    )
  }
  // The bundled look draws in the bundled family, so there is nothing to
  // fetch and nothing to say — and the widget's fetch is gated on this.
  const sketchedClean = await callTool('canvas_view', { workspaceId, documentId })
  if (sketchedClean.themeFont !== undefined) {
    throw new Error(
      `canvas_view named a theme font under the bundled look: ${JSON.stringify(sketchedClean.themeFont)}`,
    )
  }
  await callTool('wb_facet_set', {
    workspaceId,
    documentIds: [documentId],
    target: 'canvas',
    facets: { 'visual.theme/v0': null },
  })
  console.log(
    "[e2e] canvas_view(style: 'document') → themeFont for the widget, kept on its refresh; none under clean",
  )
}
