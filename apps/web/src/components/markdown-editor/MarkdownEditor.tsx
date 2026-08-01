import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import { useMemo } from 'react'
import { PreviewPane } from './PreviewPane.js'
import { SourcePane } from './SourcePane.js'
import { useDebouncedValue } from './use-debounced-value.js'

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

/**
 * A controlled markdown editor: one source-of-truth `value` string, edited
 * through a CodeMirror 6 source pane on the left and previewed on the right
 * through `renderMarkdownPreviewSvg` — the same parse -> layout -> SVG path
 * the spatial canvas's text node and export use, so there is no second
 * markdown-to-HTML renderer to drift from it.
 *
 * Deliberately out of scope, each for a specific reason:
 * - CRDT binding (`loro-codemirror`) belongs to the sync slice: binding a
 *   CodeMirror instance to a CRDT document is a persistence/collaboration
 *   concern, and this component is a plain controlled `value`/`onChange`
 *   pair that owns neither.
 * - Math / mermaid rendering needs a composition-root `renderMath`
 *   implementation (MathJax, mermaid), which apps/web does not have yet.
 *   None is injected, so math degrades to canvas-render's escaped-source
 *   placeholder and a mermaid fence renders as a plain code block.
 * - `[[wikiLink]]` / `![[embed]]` resolution needs a workspace-index-backed
 *   resolver for `resolveReferences`, which does not exist at this
 *   component's boundary; without one they stay literal bracket text.
 *
 * Preview recomputation is trailing-edge debounced so a keystroke does not
 * synchronously re-parse and re-layout the whole document — the debounce
 * always settles on the latest value, never a stale intermediate one.
 */
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
