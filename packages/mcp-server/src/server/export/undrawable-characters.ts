import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { loadExportFonts } from './measure-text.js'

/**
 * The characters this renderer's own fonts have no glyph for.
 *
 * The export path draws with the vendored Roboto plus whatever the user
 * installed, and nothing else (`loadSystemFonts: false` in
 * `headless-renderer.ts` — a deliberate choice, since the system-font scan
 * dominates first-call latency). resvg does not substitute a face it was not
 * given, so a code point NONE of those faces carries is painted as a tofu box.
 *
 * It is worth reporting because of HOW it fails. Measurement is correct
 * (`createOpentypeMeasureText` falls back to the estimator per code point), so
 * the box is the right size, the text wraps in the right places, and every
 * other signal — `truncated`, `overflows`, the digest — says the render is
 * fine. The only thing wrong is that the reader cannot read it, and nothing
 * says so.
 *
 * This is deliberately about the RENDERER's fonts, not about the text. An SVG
 * export still carries the characters as `<text>`, so a viewer whose system
 * has the face reads it normally; only rasterisation is lossy. Callers that
 * report this should say which of the two they mean.
 */
export async function undrawableCharacters(canvas: SpatialCanvas): Promise<readonly string[]> {
  const fonts = await loadExportFonts()
  // No parsed face at all means the whole render already degraded to system
  // fonts, which is logged where it happens. Claiming every character is
  // undrawable there would be a second, louder, and wrong report.
  if (fonts.length === 0) return []

  const seen = new Set<string>()
  const missing: string[] = []
  const scan = (text: string | undefined): void => {
    if (text === undefined) return
    for (const char of text) {
      if (seen.has(char)) continue
      seen.add(char)
      // Whitespace and control characters have no glyph to miss.
      if (char.trim() === '') continue
      if (fonts.every((font) => font.charToGlyphIndex(char) === 0)) missing.push(char)
    }
  }

  // First-seen order over document order: reproducible for the same canvas,
  // which a set's iteration order would not be across engines.
  for (const node of canvas.nodes) {
    if (node.type === 'text') scan(node.text)
    else if (node.type === 'group') scan(node.label)
    else if (node.type === 'file') scan(node.file)
    else if (node.type === 'link') scan(node.url)
  }
  for (const edge of canvas.edges) scan(edge.label)

  return missing
}
