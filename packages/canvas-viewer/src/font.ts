/**
 * The single source of truth for the viewer's export font family. Consumed
 * by both the browser `MeasureText` implementation (measure-text.ts) and the
 * widget's build-time font embedding (widget/font-assets.ts) so the two
 * never drift into two literal family names.
 *
 * mcp-server independently vendors the same face under its own
 * `EXPORT_FONT_FAMILY` constant — the two packages cannot import each other
 * (see architecture-map.md), so this is a deliberate, documented duplication:
 * both sides must name the same font family ("Roboto") for browser and Node
 * export metrics to agree. A future font swap on either side without
 * updating the other silently desyncs metrics rather than failing loudly.
 */
export const VIEWER_FONT_FAMILY = 'Roboto'
