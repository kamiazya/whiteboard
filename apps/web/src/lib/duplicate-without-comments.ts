import type { DuplicateDocumentRequest } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'

/**
 * The second Duplicate verb: a copy of what the document SAYS, without the
 * conversation about it. The keepers leave the whole annotation layer behind
 * — comment threads and open proposals alike (ADR-0026, ADR-0029) — and the
 * label names only comments because that is the part of the layer people
 * know by name.
 *
 * Offered on every document rather than only on one with threads: a listing
 * does not know which documents hold comments, and a verb that appeared on
 * some cards and not others would read as a menu that changes for no reason.
 */
export const DUPLICATE_WITHOUT_COMMENTS = 'Duplicate without comments'

export const WITHOUT_ANNOTATIONS = {
  withoutAnnotations: true,
} as const satisfies DuplicateDocumentRequest
