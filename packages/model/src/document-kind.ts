import { z } from 'zod'

/**
 * What a document IS, and so which structure it carries: a JSON Canvas
 * surface, or an OKF markdown body (ADR-0009 decision 4 — a document's
 * format follows from the document, never from a read parameter).
 *
 * The ADR calls this a document's FORMAT and this schema calls it a kind.
 * They are one concept, which the ADR says outright ("Kind and format are
 * already the same field") while criticising the codebase for spelling it
 * both ways at once. `kind` is the spelling that won: it is the daemon's
 * column, the index row's field, `readDocumentKind`/`writeDocumentKind`,
 * and the field every kind-carrying contract downstream already publishes.
 * Naming the type for the other half is what made the two look like
 * different things.
 *
 * Single source of truth for the spatial/markdown split — the mcp-server
 * api-contracts and the browser-local IndexedDB schema reference this
 * rather than restating the two literals.
 */
export const documentKindSchema = z.enum(['spatial', 'markdown'])
export type DocumentKind = z.infer<typeof documentKindSchema>
