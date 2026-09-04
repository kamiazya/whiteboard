/**
 * What to tell someone whose document is stored but this build cannot read it.
 *
 * The EDITOR's wording. The import panel says its own thing about the same
 * three cases, and deliberately so: it is answering "why was this skipped",
 * where this is answering "why can I not open it". Unifying the two was tried
 * and reverted — the sentences are about different actions, and a shared one
 * ends up vague about both.
 *
 * What they do share is the classification, which is the part that must not
 * drift. Every sentence here is about the STORAGE, never about the document
 * being empty or missing: the bytes are there, and telling their owner
 * otherwise is the one thing this must not do.
 */
export type DocumentReadFailure = 'unsupported-version' | 'corrupt-snapshot' | 'corrupt-delta'

const MESSAGES: Record<DocumentReadFailure, string> = {
  'unsupported-version': 'This canvas was saved by a newer version of the app. Update to open it.',
  'corrupt-snapshot': 'This canvas’s data could not be read.',
  'corrupt-delta': 'This canvas’s edit history could not be read.',
}

export function documentReadFailureMessage(kind: DocumentReadFailure): string {
  return MESSAGES[kind]
}

/**
 * Whether a backend failure means "the stored document cannot be read".
 *
 * `storage-failure` is deliberately NOT one: that is a write that did not land,
 * which the header's save status already reports, and it says nothing about
 * whether the stored document is readable.
 */
export function isDocumentReadFailure(reason: string | null): reason is DocumentReadFailure {
  return reason !== null && reason in MESSAGES
}

/**
 * The read did not complete — which is NOT one of the three above, and the
 * distinction is the whole point of this pair.
 *
 * Those three are verdicts on the stored bytes and earn the recovery action
 * that discards them. This one carries no verdict: IndexedDB fails
 * transiently for reasons that say nothing about the document, and answering
 * it with "your data could not be read" plus a button whose only effect is to
 * delete that data inverts what actually happened. So the sentence says what
 * is true — nothing was read this time — and the only action offered is to
 * try again.
 */
export const DOCUMENT_READ_UNAVAILABLE = 'read-unavailable'

export function isDocumentReadUnavailable(reason: string | null): boolean {
  return reason === DOCUMENT_READ_UNAVAILABLE
}

export function documentReadUnavailableMessage(): string {
  return 'This canvas could not be opened just now. Nothing has been changed.'
}
