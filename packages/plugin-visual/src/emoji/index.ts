/**
 * The emoji catalog as a reusable subpath, `@kamiazya/whiteboard-plugin-visual/emoji`.
 *
 * Separate from the package's default entry because the tables are 190KB
 * and the default entry is loaded wherever a document is READ — the SVG
 * renderer, the layout worker, the MCP server — none of which opens a
 * picker. Whoever wants the rows reaches for this, and pays for them.
 *
 * Two consumers so far: the facet picker (through `data.ts`'s dynamic
 * import of `sections.js`) and, next, the markdown editor's `:name:`
 * shortcode — which needs the same slug function and the same table, and
 * would otherwise grow a second copy of both.
 */
export { EMOJI_VERSION } from './catalog-data.js'
export { EMOJI_JA_TAG } from './catalog-ja.js'
export { emojiSections } from './sections.js'
export { emojiSlug } from './slug.js'
