const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Whether a string OPENS with an OKF frontmatter block — the question a
 * caller has to answer before deciding whether a string is a whole document
 * or only a body.
 *
 * One definition of what a block is, beside the reader's: a caller that
 * reimplemented the test would eventually disagree with the reader (the
 * core's shim cuts a head with the same fences, `packages/core-wasm/src/okf.ts`'s
 * `HEAD`), and both ways of disagreeing are bad — treat a document as a body and it gets a
 * second frontmatter wrapped around its first; treat a body as a document and
 * it is refused for a block it never claimed to have.
 *
 * TRUE says only that a block OPENS the string, never that its contents
 * parse: a malformed frontmatter is still a mistake for `parseOkf` to
 * report, and a caller must not use this to route one into a body.
 */
export function hasOkfFrontmatter(text: string): boolean {
  return FRONTMATTER_PATTERN.test(text)
}
