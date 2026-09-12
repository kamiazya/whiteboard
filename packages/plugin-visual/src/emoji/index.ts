/**
 * The emoji catalog as a reusable subpath, `@kamiazya/whiteboard-plugin-visual/emoji`.
 *
 * Separate from the package's default entry because the tables are 190KB
 * and the default entry is loaded wherever a document is READ — the SVG
 * renderer, the layout worker, the MCP server — none of which opens a
 * picker. Whoever wants the rows reaches for this, and pays for them.
 *
 * Its readers are three, and they are one vocabulary read three ways: the
 * facet picker (through `data.ts`'s dynamic import of `sections.js`), the
 * renderer resolving a `:name:` while drawing (`./shortcode`, which is on
 * the READ path and so imports no search index), and the markdown editor's
 * `:` completion offering one while typing (`./search`, which does). Each
 * is its own subpath because what they cost differs by an order of
 * magnitude; what they must never differ on is what a name means, which is
 * why all three go through `emojiSlug` over the same rows.
 */
export { EMOJI_VERSION } from './catalog-data.js'
export { EMOJI_JA_TAG } from './catalog-ja.js'
export { emojiSections } from './sections.js'
export { emojiSlug } from './slug.js'
