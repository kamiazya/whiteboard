// The markdown size limit where a person makes the edit. Both keepers refuse
// a body past `MARKDOWN_MAX_CHARS`, and a daemon-kept document's sync worker
// retries a refused write without end, so an edit that would cross the limit
// must never be made rather than be refused after it is.
import {
  Annotation,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import { EditorView, type Panel, showPanel } from '@codemirror/view'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'

/**
 * Marks a dispatch that carries a value from outside the editor — the
 * controlled host's reconcile — which the limit does not judge: the person
 * did not make it, and refusing it would leave the editor showing something
 * other than the document.
 */
export const externalValue = Annotation.define<true>()

/** Dispatched in place of a refused edit, carrying the length it would have made. */
const refused = StateEffect.define<number>()

/** The length of the last refused edit, until the next edit that lands. */
const refusal = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(refused)) return effect.value
    return tr.docChanged ? null : value
  },
  provide: (field) => showPanel.from(field, (length) => (length === null ? null : notice(length))),
})

const COUNT = new Intl.NumberFormat('en-US')

function notice(length: number): (view: unknown) => Panel {
  return () => {
    const dom = document.createElement('div')
    dom.setAttribute('role', 'status')
    dom.className = 'cm-length-limit-notice'
    dom.textContent = `Not added: this would make the document ${COUNT.format(length)} characters long, past the ${COUNT.format(MARKDOWN_MAX_CHARS)}-character limit. Split the content across documents.`
    return { dom, top: true }
  }
}

/**
 * Whether a transaction is somebody else's write rather than this person's:
 * the CRDT binding marks what it applies from the document with
 * `addToHistory: false`, and the reconcile with `externalValue`.
 */
function arrivedFromOutside(tr: Transaction): boolean {
  return tr.annotation(Transaction.addToHistory) === false || tr.annotation(externalValue) === true
}

/**
 * Refuses an edit that would leave the document longer than `limit` and
 * longer than it was. Shrinking a document already past the limit is let
 * through, as the keepers let it through: refusing it would leave the
 * document stuck. The refused edit is replaced by an effect the notice reads,
 * so a paste that did nothing says why.
 */
export function markdownLengthLimit(limit: number = MARKDOWN_MAX_CHARS): Extension {
  return [
    refusal,
    // The app's own colours: CodeMirror's base theme paints panels a fixed
    // light grey, which on the dark theme is a white bar.
    EditorView.theme({
      '.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
      '.cm-panels-top': { borderBottom: '1px solid var(--destructive)' },
      '.cm-length-limit-notice': { padding: '6px 24px', fontSize: '13px' },
    }),
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || arrivedFromOutside(tr)) return tr
      const length = tr.newDoc.length
      if (length <= limit || length <= tr.startState.doc.length) return tr
      return { effects: refused.of(length) }
    }),
  ]
}
