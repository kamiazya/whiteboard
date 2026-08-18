import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarkdownEditorProps } from '../markdown-editor/MarkdownEditor.js'
import { MarkdownEditor } from '../markdown-editor/MarkdownEditor.js'

export interface NodeTextEditorOverlayProps
  extends Pick<MarkdownEditorProps, 'theme' | 'resolveAlias' | 'resolveEmbed' | 'linkTargets'> {
  /** What the surface is editing, shown so the canvas context is not lost. */
  readonly title: string
  readonly initialText: string
  /** Called with the edited body — only when it actually differs. */
  readonly onCommit: (text: string) => void
  readonly onClose: () => void
}

/**
 * A canvas node's body on the same surface a document gets.
 *
 * The inline node editor is bounded by the node's own box, which is right for
 * a line and wrong for a body — and the box cannot simply grow, because its
 * size is the author's layout decision. So the long form opens over the
 * canvas instead, with the editor's own affordances (view modes, the ⋯
 * catalog, the link picker) intact.
 *
 * The commit grammar is the inline editor's, deliberately: closing commits,
 * ⌘Enter commits, Escape discards. Two doors onto the same text that agreed
 * about everything except when the writing is kept would be worse than one.
 */
export function NodeTextEditorOverlay({
  title,
  initialText,
  onCommit,
  onClose,
  theme,
  resolveAlias,
  resolveEmbed,
  linkTargets,
}: NodeTextEditorOverlayProps) {
  const [text, setText] = useState(initialText)
  // The keydown handler is bound once; without a ref it would close over the
  // text as it stood at mount and commit an empty edit.
  const textRef = useRef(initialText)
  textRef.current = text

  const commitAndClose = useCallback(() => {
    if (textRef.current !== initialText) onCommit(textRef.current)
    onClose()
  }, [initialText, onCommit, onClose])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      // The editor's own Mod-Enter toggles a task item, and that binding is
      // right inside a document. Here the surface itself is the thing being
      // exited, so the commit wins — the same precedence the inline node
      // editor applies.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        commitAndClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [commitAndClose, onClose])

  return (
    <div
      data-testid="node-text-overlay"
      role="dialog"
      aria-label={`Editing ${title}`}
      className="bg-background absolute inset-0 z-30 flex flex-col"
    >
      <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <button
          type="button"
          aria-label="Back to canvas"
          onClick={commitAndClose}
          className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Canvas
        </button>
        <span className="text-foreground truncate text-sm font-medium">{title}</span>
      </div>
      <div className="min-h-0 flex-1">
        <MarkdownEditor
          value={text}
          onChange={setText}
          className="h-full"
          autoFocus
          theme={theme}
          resolveAlias={resolveAlias}
          resolveEmbed={resolveEmbed}
          linkTargets={linkTargets}
        />
      </div>
    </div>
  )
}
