import { completionStatus, startCompletion } from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * A deletion re-asks the completion sources, the way typing already does.
 *
 * CodeMirror activates on TYPING (`activateOnTyping`) and has no counterpart
 * for deletion, so a query that shrinks keeps an OPEN popup alive through
 * `validFor` while a closed one stays closed. Measured before writing this:
 * `ship it :rocket:` plus one backspace leaves `status=null popup=false` —
 * and backspacing into a name finished long ago, where no popup was ever
 * open, is the ordinary way to fix a typo in one.
 *
 * **It learns no trigger of its own**, which is the whole design. It asks the
 * plugin to run whatever sources are installed and each decides by its own
 * rule, so `[[`, `:` and anything added later behave alike without an edit
 * here. A copy of either trigger would be a second place for the same fact,
 * and the stale one is always the one nobody is looking at.
 */
export function completionOnDelete(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return
    // A DELETION only. Insertion is already the plugin's own job, and this
    // is what keeps the module's name true rather than "on any change".
    if (!update.transactions.some((tr) => tr.isUserEvent('delete'))) return
    // An open or in-flight query owns itself — `validFor` is already handling
    // the shrinking case, and restarting re-runs the source. Measured over
    // four backspaces that shrink an open list: 2 source calls with this
    // guard, 5 without, each one a scan of the 1914-row emoji index.
    if (completionStatus(update.state) !== null) return
    startCompletion(update.view)
  })
}
