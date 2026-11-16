/**
 * `canvas_view` hands the MCP Apps widget the picture the daemon laid out, in
 * the RESULT's `_meta` (ADR-0054 step 7, q54), and leaves what the model reads
 * as it was: the text block is the structured content and no SVG.
 *
 * Read off the raw JSON-RPC answer, because `callTool` returns the parsed
 * text only — which is exactly the half that must NOT carry the picture. The
 * key is spelled here because this script cannot import canvas-render's
 * TypeScript; mcp-server's `canvas-view-widget.contract.test.ts` ties the
 * widget's reader to the constant itself.
 */
const PICTURE_META_KEY = 'whiteboard/canvas-view-picture'

export async function canvasViewHandsTheWidgetItsPicture(rpc, workspaceId, documentId) {
  const res = await rpc('tools/call', {
    name: 'canvas_view',
    arguments: { workspaceId, documentId },
  })
  if (res?.isError) throw new Error(`canvas_view refused: ${JSON.stringify(res.content)}`)
  const picture = res?._meta?.[PICTURE_META_KEY]
  if (typeof picture?.svg !== 'string' || !picture.svg.startsWith('<svg ')) {
    throw new Error(`canvas_view sent the widget no picture: ${JSON.stringify(res?._meta)}`)
  }
  const ids = res.structuredContent.scene.nodes.map((node) => node.id).sort()
  const boxed = (picture.boxes ?? []).map((box) => box.id).sort()
  if (ids.length === 0 || JSON.stringify(boxed) !== JSON.stringify(ids)) {
    throw new Error(`canvas_view's picture boxes ${boxed} are not the scene's nodes ${ids}`)
  }
  const text = res.content?.[0]?.text
  if (text !== JSON.stringify(res.structuredContent) || text.includes('<svg')) {
    throw new Error('canvas_view put the picture where the model reads it')
  }
  console.log(
    `[e2e] canvas_view → the widget's picture in _meta (${picture.svg.length} chars, ${boxed.length} boxes); the model's text unchanged`,
  )
}
