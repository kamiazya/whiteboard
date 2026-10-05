// A size limit where a person makes the edit. Either keeper refuses a write
// past its bound, and the page then goes back to what the keeper holds —
// undoing that edit and everything typed after it, since each later edit is
// built on the refused one. So an edit that would cross a limit is never
// made, rather than refused after it is and taking more with it. One shape
// for every bounded text a CodeMirror view edits.
import {
  Annotation,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import { EditorView, type Panel, showPanel } from '@codemirror/view'
import { growsPast } from '@kamiazya/whiteboard-model'

/**
 * Marks a dispatch that carries a value from outside the editor — the
 * controlled host's reconcile — which the limit does not judge: the person
 * did not make it, and refusing it would leave the editor showing something
 * other than the document.
 */
export const externalValue = Annotation.define<true>()

/**
 * Whether a transaction is somebody else's write rather than this person's:
 * the CRDT binding marks what it applies from the document with
 * `addToHistory: false`, and the reconcile with `externalValue`.
 */
function arrivedFromOutside(tr: Transaction): boolean {
  return tr.annotation(Transaction.addToHistory) === false || tr.annotation(externalValue) === true
}

/**
 * Refuses an edit that would leave the text longer than `limit` and longer
 * than it was. Shrinking a text already past the limit is let through, as
 * the keepers let it through: refusing it would leave the text stuck. The
 * refused edit is replaced by an effect the notice reads, so a paste that
 * did nothing says why — in the words `describe` gives the length it would
 * have made.
 *
 * Each call carries its own state, so two limits installed in one editor
 * each report only the edits they refused. `compact` sets the notice small,
 * for an editor that shares a node's box or a comment bubble with it.
 */
export function textLengthLimit(
  limit: number,
  describe: (length: number) => string,
  { compact = false }: { readonly compact?: boolean } = {},
): Extension {
  const refused = StateEffect.define<number>()
  // The length of the last refused edit, until the next edit that lands.
  const refusal = StateField.define<number | null>({
    create: () => null,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(refused)) return effect.value
      return tr.docChanged ? null : value
    },
    provide: (field) =>
      showPanel.from(field, (length) => (length === null ? null : notice(describe(length)))),
  })
  return [
    refusal,
    // The app's own colours: CodeMirror's base theme paints panels a fixed
    // light grey, which on the dark theme is a white bar.
    EditorView.theme({
      '.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
      '.cm-panels-top': { borderBottom: '1px solid var(--destructive)' },
      '.cm-length-limit-notice': compact
        ? { padding: '2px 4px', fontSize: '11px', lineHeight: '1.3' }
        : { padding: '6px 24px', fontSize: '13px' },
    }),
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || arrivedFromOutside(tr)) return tr
      const length = tr.newDoc.length
      if (!growsPast(limit, tr.startState.doc.length, length)) return tr
      return { effects: refused.of(length) }
    }),
  ]
}

function notice(text: string): (view: unknown) => Panel {
  return () => {
    const dom = document.createElement('div')
    dom.setAttribute('role', 'status')
    dom.className = 'cm-length-limit-notice'
    dom.textContent = text
    return { dom, top: true }
  }
}
