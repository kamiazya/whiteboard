/**
 * Binds a CodeMirror view to a Loro text container, in both directions.
 *
 * This was `loro-codemirror`'s `LoroSyncPlugin` until we had patched three
 * defects out of its 131-line `sync.js` (+68/-54 lines) — half the file we
 * actually ran, and the half that decides correctness. A patch on a `dist/*.js`
 * is invisible to typecheck, to knip and to a reader, so what we had was a fork
 * with extra steps and no types. The rest of that package (undo, awareness,
 * ephemeral: 685 lines) we never used.
 *
 * Written against the tests rather than copied, deliberately. All three defects
 * came out of the same upstream shape — branch on `e.by`, replay the event
 * batch's deltas, and keep an `isInitDispatch` flag to recognise your own
 * seeding — and none of them was visible by reading it. Every one showed up
 * only when a test used the shape this app actually has: a text container on a
 * workspace document's tree node, where any batch also carries tree and node
 * events. So the shape is gone, not repaired:
 *
 * - **The container is the truth; the view follows.** Seeding and every later
 *   change are the same reconcile, so there is no separate init path to get
 *   wrong, and no `e.by` to branch on. A local write from a version restore,
 *   an import from the daemon and a checkout all arrive the same way.
 * - **Diff the text, do not replay the deltas.** Comparing against what the
 *   view actually holds cannot double-apply and needs no event filtering. It
 *   is also why the echo of our own write costs nothing: by the time the
 *   subscription fires, the two already agree.
 * - **Every dispatch we make is annotated.** `update()` recognises its own
 *   work by that annotation, which is what retires the flag — upstream's was
 *   armed before an early return that skipped the dispatch, so it stood
 *   waiting and swallowed the user's first keystroke instead.
 */

import { minimalChange } from '@kamiazya/whiteboard-loro-adapter'
import { Annotation, type Extension, Transaction } from '@codemirror/state'
import { type EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { LoroDoc, LoroText, Subscription } from 'loro-crdt'

/**
 * Marks a transaction this binding dispatched, so `update()` does not write it
 * back to the container it came from.
 */
const fromContainer = Annotation.define<true>()

/**
 * Reads the container this view is bound to.
 *
 * Called per operation rather than captured once: in workspace mode the body
 * lives on the document's tree node, and `documentContainers` re-resolves it,
 * so a handle stays valid across a move.
 */
export type ReadBoundText = (doc: LoroDoc) => LoroText

class LoroTextSync implements PluginValue {
  private readonly unsubscribe: Subscription

  constructor(
    private readonly view: EditorView,
    private readonly doc: LoroDoc,
    private readonly readText: ReadBoundText,
  ) {
    this.unsubscribe = doc.subscribe(() => this.reconcile())
    // Deferred because a ViewPlugin is constructed DURING a state update, and
    // CodeMirror refuses a dispatch from inside one. A microtask is the first
    // moment the view will accept the seeding.
    queueMicrotask(() => this.reconcile())
  }

  /** Make the view say what the container says, in one minimal splice. */
  private reconcile(): void {
    const next = this.readText(this.doc).toString()
    const current = this.view.state.doc.toString()
    // The batch our own `update()` just produced lands here too, and by now
    // the two agree — so this is the whole of "don't echo yourself". An early
    // return rather than an empty dispatch: a workspace document publishes an
    // event for every document in it, and almost none of them are this body.
    if (current === next) return
    this.view.dispatch({
      // The same single-span diff `writeMarkdownBody` uses, so the two paths
      // into a body cannot disagree about what "minimal" means.
      changes: [minimalChange(current, next)],
      annotations: [
        fromContainer.of(true),
        // Not this user's edit, so it must not enter the editor's own undo
        // stack. `history()` maps its stored inverse through every later
        // change, so without this one Ctrl-Z after a peer's change empties the
        // document — and the write-back below sends that deletion to the peer.
        Transaction.addToHistory.of(false),
      ],
    })
  }

  update(update: ViewUpdate): void {
    // Per TRANSACTION, not over `update.changes`. One ViewUpdate can batch a
    // transaction of ours with one of the user's, and the merged changeset
    // cannot say which range came from where — so a check on the batch as a
    // whole either drops the user's edit or writes ours back twice.
    for (const transaction of update.transactions) {
      if (!transaction.docChanged) continue
      if (transaction.annotation(fromContainer) !== undefined) continue
      this.applyToContainer(transaction)
    }
  }

  /**
   * One transaction's changes, at the positions it names.
   *
   * `iterChanges` reports positions in the document as it stood BEFORE this
   * transaction, which is also the container's state — every earlier
   * transaction in this batch has already been applied. `adj` carries the
   * drift each edit adds for the ones after it in the same transaction.
   */
  private applyToContainer(transaction: Transaction): void {
    const text = this.readText(this.doc)
    let adj = 0
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const insert = inserted.sliceString(0, inserted.length, '\n')
      if (toA > fromA) text.delete(fromA + adj, toA - fromA)
      if (insert.length > 0) text.insert(fromA + adj, insert)
      adj += insert.length - (toA - fromA)
    })
    this.doc.commit()
  }

  destroy(): void {
    this.unsubscribe()
  }
}

/**
 * The extension a composition root installs to bind an editor to a document's
 * text container.
 *
 * Append it AFTER the built-in extensions: the binding has to observe the
 * document they produce, not the one before them.
 */
export function loroTextSync(doc: LoroDoc, readText: ReadBoundText): Extension {
  return ViewPlugin.define((view) => new LoroTextSync(view, doc, readText))
}
