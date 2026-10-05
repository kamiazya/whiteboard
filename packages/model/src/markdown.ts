import { z } from 'zod'

/**
 * Markdown-format documents carry a plain-text body — no structural schema.
 * Wiki links stay plain text (`[[<ULID>]]`) inside that string; the
 * markdown parser (mdast subset) is a separate concern from this envelope.
 */
export const markdownDocumentSchema = z.object({
  body: z.string(),
})

export type MarkdownDocument = z.infer<typeof markdownDocumentSchema>

/**
 * The most characters (UTF-16 code units, which is what `String#length` and
 * `z.string().max` count) one markdown write may carry.
 *
 * Loro imports a text insert into a document that already holds anything in
 * time QUADRATIC in its length, and every content write merges the body into
 * the workspace record that way: on the full create path 128 Ki characters
 * cost ~0.5 s of CPU, 192 Ki ~0.9 s and 256 Ki ~1.3 s (a single line, short
 * lines and paragraphs alike), so doubling the limit would quadruple the time
 * the daemon's loop is blocked; a single 4 MiB line makes the WASM trap
 * (`unreachable`) after minutes and leaves that document's in-memory copy
 * unusable. Characters, not bytes, because the cost follows the character
 * count: 256 KiB of CJK (87 Ki characters) imports in 0.16 s and of ASCII in
 * 1.3 s. The limit sits where one write still finishes in about a second, far
 * past any prose a person or an agent writes into one document.
 */
export const MARKDOWN_MAX_CHARS = 256 * 1024

/**
 * The bound as every refusal of it ends, as `NODE_TEXT_LIMIT_PHRASE` is for a
 * node's text. "For one document" fits each refusal alike: a whole document's
 * markdown, a body an edit or update would grow, and a single insert, which no
 * document could hold either.
 */
export const MARKDOWN_LIMIT_PHRASE = `the ${MARKDOWN_MAX_CHARS}-character limit for one document; split the content across documents`

/**
 * The `markdown` string a tool or route accepts for a whole document —
 * frontmatter and body together. One definition so a write is refused the same
 * way whichever surface it arrives through.
 */
export const markdownInputSchema = z
  .string()
  .max(MARKDOWN_MAX_CHARS, `markdown is longer than ${MARKDOWN_LIMIT_PHRASE}`)
