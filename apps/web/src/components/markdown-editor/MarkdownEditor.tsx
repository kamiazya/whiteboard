import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import { useMemo } from 'react'
import { PreviewPane } from './PreviewPane.js'
import { SourcePane } from './SourcePane.js'
import { useDebouncedValue } from './use-debounced-value.js'

/**
 * A controlled markdown editor: one source-of-truth `value` string, edited
 * through a CodeMirror 6 source pane on the left and rendered through a
 * canvas-render-backed preview pane on the right.
 *
 * Supported today: CommonMark + GFM (tables, strikethrough, task lists) —
 * the same closed syntax set `parseMarkdownBody` accepts — rendered through
 * the SAME parse -> layout -> SVG path used by the spatial canvas's text
 * node and by export (`renderMarkdownPreviewSvg`, `render-preview.ts`).
 * There is deliberately no second, markdown-to-HTML renderer in this
 * component; a math block degrades to canvas-render's documented
 * escaped-source placeholder rather than rendering nothing.
 *
 * Deliberately OUT of scope for this slice, each for a specific reason:
 * - CRDT binding (`loro-codemirror`): belongs to the sync slice. Binding a
 *   CodeMirror instance to a CRDT document is a persistence/collaboration
 *   concern, and this component owns neither — it is a plain controlled
 *   `value`/`onChange` pair.
 * - Math / mermaid rendering: canvas-render models both as an SVG-fragment
 *   seam node whose content a composition root injects via `renderMath`.
 *   No such renderer (MathJax, mermaid) exists in apps/web yet, so this
 *   component deliberately does NOT inject one — math shows its escaped
 *   source, and a ```mermaid fence renders as a plain code block.
 * - `[[wikiLink]]` / `![[embed]]` resolution: `resolveReferences` needs an
 *   injected resolver backed by the workspace index, which does not exist
 *   at this component's boundary. Without one, this is `parseMarkdownBody`
 *   alone's documented behavior: those stay literal bracket text.
 *
 * Preview recomputation is trailing-edge debounced (default 150ms, see
 * `useDebouncedValue`) so a keystroke does not synchronously re-parse and
 * re-layout the whole document on every character — the debounce always
 * settles on the LATEST value, never a stale intermediate one.
 */
export interface MarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  className?: string
  /** Preview layout width in px. Defaults to a reasonable single-pane width. */
  maxWidth?: number
  /** Trailing-edge debounce delay for preview recomputation. Default 150ms. */
  previewDebounceMs?: number
  /** Injection seam for tests; defaults to the real Canvas 2D measurer. */
  measure?: MeasureText
}

const DEFAULT_MAX_WIDTH = 480
const DEFAULT_PREVIEW_DEBOUNCE_MS = 150

export function MarkdownEditor({
  value,
  onChange,
  className,
  maxWidth = DEFAULT_MAX_WIDTH,
  previewDebounceMs = DEFAULT_PREVIEW_DEBOUNCE_MS,
  measure,
}: MarkdownEditorProps) {
  const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])
  const debouncedValue = useDebouncedValue(value, previewDebounceMs)

  return (
    <div className={className} style={{ display: 'flex', width: '100%', height: '100%' }}>
      <SourcePane value={value} onChange={onChange} className="markdown-editor-source" />
      <PreviewPane value={debouncedValue} maxWidth={maxWidth} measure={resolvedMeasure} />
    </div>
  )
}
