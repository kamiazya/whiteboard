// The tokeniser's output vocabulary, owned by the stage that produces it.
// `layout/` reads it through `MdastLayoutOptions.highlightCode`, so it sits
// below layout rather than in a layout module the tokeniser would import.

/**
 * The closed set of things a code token can be. Five roles including plain
 * (a token with no role), not forty TextMate scopes: at 10-12px inside a
 * node, finer resolution is discarded on the way out, and each role has to
 * hold its own contrast floor against the code surface.
 */
export type CodeTokenRole = 'keyword' | 'string' | 'number' | 'comment'

export interface CodeToken {
  readonly text: string
  /** Absent means plain — the token paints as body text. */
  readonly role?: CodeTokenRole
}

/** One array per source line, in source order. */
export type CodeTokenLines = readonly (readonly CodeToken[])[]
