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
  // reader out of tidying up. A browser workspace keeps no versions — those
  // are a daemon feature — so the trash is the whole story here.
  'delete-document-browser': (noun) => `The ${noun} moves to the Trash, where you can restore it.`,

  // Recoverable in the same way: document-store.ts routes the delete through
  // the index, which evacuates into the trash and keeps the same
  // recoverability promise the agent-facing port makes. What genuinely does
  // NOT come back is the versions and branches — documentTeardown deletes
  // those rows, and the trash holds only the tree subtree — so that is the
  // half worth warning about, rather than a blanket "no undo" that is false.
  'delete-document-daemon': (noun) =>
    `The ${noun} moves to the Trash, where you can restore it. Its versions and branches are deleted, and restoring does not bring them back.`,

  // The bulk pair. Separate entries rather than one number-aware sentence,
  // because English agreement ("moves"/"move", "it"/"them") would put a
  // branch inside the one place this module exists to keep branch-free — and
  // a selection of ONE never reaches here anyway: the panel routes it to the
  // singular confirmation above, which can name the document.
  'delete-documents-browser': (noun) =>
    `The selected ${noun} move to the Trash, where you can restore them.`,

  'delete-documents-daemon': (noun) =>
    `The selected ${noun} move to the Trash, where you can restore them. Their versions and branches are deleted, and restoring does not bring them back.`,
} satisfies Record<DestructiveActionId, DestructiveDescription>

/**
 * A subject no copy would ever contain, so splitting on it recovers a
 * sentence's static halves without anyone writing them down a second time.
 */
const SUBJECT_HOLE = '\u0000'

/**
 * The static text a description is built from — the halves either side of
 * the subject.
 *
 * Derived by calling the builder rather than listed by hand: a listed
 * fragment is one more copy to keep in step, which is the defect this module
 * exists to remove.
 */
export function destructiveCopyFragments(build: DestructiveDescription): string[] {
  return build(SUBJECT_HOLE)
    .split(SUBJECT_HOLE)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0)
}
