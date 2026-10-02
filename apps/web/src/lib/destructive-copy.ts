/**
 * The sentence a destructive confirmation shows about the user's data —
 * declared once, so the promise it makes exists in exactly one place.
 *
 * Scope is the DESCRIPTION and nothing else. That is the line that says
 * whether the thing comes back, which is the half that has been wrong and
 * the half a reader decides on. Titles ("Delete this note?") carry no
 * promise, differ in subject between the list and the document page, and
 * have never drifted — folding them in would buy a two-subject signature
 * for nothing.
 *
 * Why a module rather than three string literals: a correction has to reach
 * every site, and nothing made it. The browser sentence was already written
 * out twice (the list page and the document page), and when this copy was
 * last corrected a grep for the old phrasing found four of the six places
 * that carried it — the two it missed were tests asserting a middle
 * fragment, and only the full suite disagreed. Importing the same builder at
 * every site, tests included, removes the class rather than re-checking for
 * it: there is one string, so there is nothing to keep in step.
 *
 * `destructive-copy-surface.test.ts` holds that line — it scans the source
 * for these sentences appearing anywhere but here.
 *
 * This surface deliberately has NO coverage ledger. Per
 * `.claude/rules/coverage-ledger.md` a ledger is the third step of
 * declare -> model -> pin, and nothing models confirmation copy: there is no
 * property or table-driven run to tally, so a ledger here would be the
 * hand-maintained list of names that rule exists to replace. The declaration
 * plus the scan is the whole mechanism.
 */

/** A destructive confirmation this app shows. */
export type DestructiveActionId =
  | 'delete-document-browser'
  | 'delete-document-daemon'
  | 'delete-documents-browser'
  | 'delete-documents-daemon'
  | 'remove-member'
  | 'delete-person'
  | 'delete-replica-copy'

/**
 * Built from the noun for the thing being destroyed, so a note reads "The
 * note ..." and a canvas "The canvas ...". Taking the noun rather than
 * baking one in is what lets a single sentence serve both kinds.
 */
export type DestructiveDescription = (noun: string) => string

export const DESTRUCTIVE_COPY = {
  // The delete evacuates into the trash before removing anything
  // (loro-workspace-document-index's "EVACUATE FIRST"), and the Trash
  // section restores it. Older copy said "There is no undo", which talks a
  // reader out of tidying up. A browser delete removes no version rows, and a
  // restore brings the document back under the documentId they are keyed by
  // (browser-version-store.trash.test.ts), so the trash is the whole story
  // and the copy says the history returns with it.
  'delete-document-browser': (noun) =>
    `The ${noun} moves to the Trash, where you can restore it with its saved versions.`,

  // Recoverable in the same way: document-store.ts routes the delete through
  // the index, which evacuates into the trash and keeps the same
  // recoverability promise the agent-facing port makes. What genuinely does
  // NOT come back is the saved versions — documentTeardown deletes those
  // rows, and the trash holds only the tree subtree — so that is the half
  // worth warning about, rather than a blanket "no undo" that is false.
  'delete-document-daemon': (noun) =>
    `The ${noun} moves to the Trash, where you can restore it. Its saved versions are deleted, and restoring does not bring them back.`,

  // The bulk pair. Separate entries rather than one number-aware sentence,
  // because English agreement ("moves"/"move", "it"/"them") would put a
  // conditional inside the one place this module exists to keep
  // conditional-free — and a selection of ONE never reaches here anyway: the
  // panel routes it to the singular confirmation above, which can name the
  // document.
  'delete-documents-browser': (noun) =>
    `The selected ${noun} move to the Trash, where you can restore them with their saved versions.`,

  'delete-documents-daemon': (noun) =>
    `The selected ${noun} move to the Trash, where you can restore them. Their saved versions are deleted, and restoring does not bring them back.`,

  // The subject here is a PERSON'S NAME, not a kind noun — `DestructiveDescription`'s
  // parameter still fits, since a name is just the string it is handed.
  // Removal is L1 revocation (ADR-0041 decision 3): synchronous, and it ends
  // access now rather than at some later sync.
  'remove-member': (name) =>
    `Remove ${name} from this workspace? They lose access now, and anything they change offline after this point will not be kept.`,

  // ADR-0051: final, unlike the deactivation it follows. What the person wrote
  // stays; what the keeper knew of them does not, so coming back is arriving
  // new. The subject is the person's name.
  'delete-person': (name) =>
    `Delete ${name}? This cannot be undone. What they wrote stays, but this server forgets them: if they sign in again, they arrive as someone new.`,

  // Deleting a CACHED copy is housekeeping, not revocation (ADR-0042
  // decision 3): the daemon still keeps the workspace, so the only thing at
  // risk is what this device has not managed to send yet. Saying "the
  // workspace is deleted" would be false, and saying "nothing is lost" would
  // be false too whenever the daemon has been unreachable — so the sentence
  // names exactly the one thing that does not come back. The subject is the
  // workspace's own name.
  'delete-replica-copy': (name) =>
    `This device's copy of ${name} is removed. Anything in it that has not reached the daemon yet is lost; the daemon keeps the workspace, so a copy can be pulled again.`,
} satisfies Record<DestructiveActionId, DestructiveDescription>
