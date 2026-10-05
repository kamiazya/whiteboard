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

import { Annotation, type Extension, Transaction } from '@codemirror/state'
import { type EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { minimalChange } from '@kamiazya/whiteboard-loro-adapter'
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
 * so a handle stays valid across a move. `null` once the document has left
 * the record: there is nothing to bind, and the binding leaves the view alone.
 */
export type ReadBoundText = (doc: LoroDoc) => LoroText | null

class LoroTextSync implements PluginValue {
  private readonly unsubscribe: Subscription
  private disposed = false

  constructor(
    private readonly view: EditorView,
    private readonly doc: LoroDoc,
    private readonly readText: ReadBoundText,
    private readonly commit: () => void,
    private readonly adoptInitial: ((text: string) => void) | undefined,
  ) {
    this.unsubscribe = doc.subscribe(() => this.reconcile())
    // Deferred because a ViewPlugin is constructed DURING a state update, and
    // CodeMirror refuses a dispatch from inside one. A microtask is the first
    // moment the view will accept the seeding — and a view can be destroyed
    // before it arrives, which is what `disposed` below is for.
    queueMicrotask(() => this.seed())
  }

  /**
   * The first reconcile, with one case of its own: an EMPTY container under a
   * view that already shows text. The view was opened on the document's body
   * as read (`readMarkdownBody`), which falls back to a pre-unification body
   * stored as a canvas text node — so this is that document, and reconciling
   * would empty the editor and let the next keystroke write a one-character
   * container that hides the prose (the container wins on read). The owner
   * adopts the text into the container instead.
   */
  private seed(): void {
    if (this.disposed) return
    const current = this.view.state.doc.toString()
    if (this.adoptInitial !== undefined && current.length > 0) {
      if (this.readText(this.doc)?.length === 0) {
        this.adoptInitial(current)
        return
      }
    }
    this.reconcile()
  }

  /** Make the view say what the container says, in one minimal splice. */
  private reconcile(): void {
    // Nothing to do for a view nobody will look at, and reading the container
    // for one is not merely wasted: the RESOLVER can throw. This app's is
    // `documentContainers`, which answers `No document "<id>" in this
    // workspace` once the node is gone — so deleting the open document would
    // raise an unhandled error out of a microtask nobody is awaiting.
    //
    // The destroyed VIEW is not itself the hazard; CodeMirror tolerates both
    // a `state` read and a `dispatch` after `destroy()` (measured). The
    // resolver is, which is why this guards the whole method rather than the
    // dispatch.
    if (this.disposed) return
    const next = this.readText(this.doc)?.toString()
    // No container: the document left the record. The view keeps what it
    // last showed — the page locks it — rather than emptying.
    if (next === undefined) return
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
    if (text === null) return
    let adj = 0
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const insert = inserted.sliceString(0, inserted.length, '\n')
      if (toA > fromA) text.delete(fromA + adj, toA - fromA)
      if (insert.length > 0) text.insert(fromA + adj, insert)
      adj += insert.length - (toA - fromA)
    })
    this.commit()
  }

  destroy(): void {
    // Before unsubscribing, because the flag is also what stops the QUEUED
    // seeding — unsubscribing only closes the ongoing channel.
    this.disposed = true
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
export interface LoroTextSyncOptions {
  /**
   * What ends an edit's transaction. The default commits at once, which is
   * right where the owner saves on its own schedule off the commit (the
   * browser's markdown host). A sync session that pushes on every commit
   * passes its own debounced commit instead, so a burst of keystrokes is one
   * push, as it was when the editor handed the session whole texts — the
   * ops are written at their positions straight away and read back as such
   * before the commit lands.
   */
  readonly commit?: () => void
  /**
   * Writes a pre-unification body — the text the view opened on while the
   * container was still empty — into the container, the owner's way (see
   * `LoroTextSync.seed`). Absent, the view is reconciled to the container as
   * it stands.
   */
  readonly adoptInitial?: (text: string) => void
}

export function loroTextSync(
  doc: LoroDoc,
  readText: ReadBoundText,
  options: LoroTextSyncOptions = {},
): Extension {
  const commit = options.commit ?? (() => doc.commit())
  return ViewPlugin.define(
    (view) => new LoroTextSync(view, doc, readText, commit, options.adoptInitial),
  )
}

/**
 * The editor extensions for a sync session's body binding, or none before
 * the session holds a doc. Memoise on the binding: the editor is keyed on
 * the array's identity and remounts when it changes.
 */
export function sessionBodyBinding(
  binding: {
    doc: LoroDoc
    readText: ReadBoundText
    commit: () => void
    adopt: (text: string) => void
  } | null,
): Extension[] | undefined {
  return binding === null
    ? undefined
    : [
        loroTextSync(binding.doc, binding.readText, {
          commit: binding.commit,
          adoptInitial: binding.adopt,
        }),
      ]
}
