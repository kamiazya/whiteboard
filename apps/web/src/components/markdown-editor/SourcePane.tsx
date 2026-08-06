import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState, EditorSelection, type StateCommand } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useRef } from 'react'

// Wraps each selection range in `delimiter` (Mod-b -> **, Mod-i -> *). A
// collapsed selection inserts an empty pair and parks the cursor between
// the delimiters so the next keystroke lands inside. Toggling (detecting
// an already-wrapped range and unwrapping) is deliberately not attempted:
// markdown emphasis nesting makes reliable detection lexer work, and a
// wrong unwrap corrupts text — insert-only is predictable.
function wrapSelectionWith(delimiter: string): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: delimiter },
        { from: range.to, insert: delimiter },
      ],
      range: EditorSelection.range(range.from + delimiter.length, range.to + delimiter.length),
    }))
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }))
    return true
  }
}

const styleKeymap = [
  { key: 'Mod-b', run: wrapSelectionWith('**') },
  { key: 'Mod-i', run: wrapSelectionWith('*') },
]

export interface SourcePaneProps {
  value: string
  onChange: (next: string) => void
  className?: string
}

/**
 * Minimal CodeMirror 6 host — just `EditorState` + `EditorView` +
 * `markdown()` and an update listener. Deliberately not `basicSetup`'s
 * kitchen sink (line numbers, search panel, etc.): this is an editing
 * surface for a markdown canvas, not a general-purpose IDE.
 */
export function SourcePane({ value, onChange, className }: SourcePaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Always holds the latest onChange without forcing the effect below to
  // re-run (and recreate the EditorView) on every parent re-render.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        markdown(),
        history(),
        // styleKeymap precedes defaultKeymap so Mod-b/Mod-i win over any
        // default binding; indentWithTab keeps Tab in the editor (Escape
        // then Tab remains the keyboard escape hatch, per CodeMirror's
        // own accessibility guidance).
        keymap.of([...styleKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        // Prose, not code: long paragraphs soft-wrap instead of growing a
        // horizontal scrollbar.
        EditorView.lineWrapping,
        // Fill the host pane instead of sizing to content: without a
        // bounded height the scroller never scrolls and the pane collapses
        // to its padding inside a flex row.
        EditorView.theme({
          '&': { height: '100%', width: '100%' },
          '.cm-scroller': { overflow: 'auto' },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
      ],
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Intentionally created once per mount — external `value` changes are
    // reconciled below, not by recreating the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    // Guard against an edit loop: dispatching every re-render (even with an
    // identical `value`) would reset the cursor/selection under the user on
    // every keystroke, since a controlled parent typically echoes the same
    // value straight back in via `onChange`.
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    })
  }, [value])

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}
      data-testid="markdown-source-pane"
    />
  )
}
