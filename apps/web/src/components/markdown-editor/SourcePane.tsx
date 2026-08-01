import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'react'

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

  return <div ref={hostRef} className={className} data-testid="markdown-source-pane" />
}
