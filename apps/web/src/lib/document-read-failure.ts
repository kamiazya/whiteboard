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
export type DocumentReadFailure =
  | 'unsupported-version'
  | 'corrupt-snapshot'
  | 'corrupt-delta'
  | 'read-unavailable'

const MESSAGES: Record<DocumentReadFailure, string> = {
  'unsupported-version': 'This canvas was saved by a newer version of the app. Update to open it.',
  'corrupt-snapshot': 'This canvas’s data could not be read.',
  'corrupt-delta': 'This canvas’s edit history could not be read.',
  // The fourth is the one that is NOT about the bytes: storage did not answer,
  // so nothing at all is known about them. It belongs here rather than under
  // `storage-failure` because the consequence is the same as the others' —
  // the content never arrived, so there is no document to edit and the editor
  // must not be presented over an empty canvas. What it must NOT share is the
  // recovery: `Start fresh` deletes the record, and offering that over data
  // whose only problem was a blocked read is how someone loses work by
  // opening a document twice.
  'read-unavailable': 'This canvas could not be opened just now. Its data has not been changed.',
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
