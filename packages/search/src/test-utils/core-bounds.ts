/**
 * The core's two excerpt bounds (`crates/core/search`: `CONTEXT_RADIUS`,
 * `EXCERPT_TOKENS_MAX`), written here so a test can aim a character at the
 * cut or a query at the token bound. A test that places a character on the
 * boundary fails when the core moves it, and `snippet.test.ts` pins the
 * radius by measuring it.
 */
export const CONTEXT_RADIUS = 60
export const EXCERPT_TOKENS_MAX = 64
