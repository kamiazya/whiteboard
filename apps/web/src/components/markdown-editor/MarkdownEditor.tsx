import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
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
  /** Focus the source pane on mount (fresh-note flows). */
  autoFocus?: boolean
  /** Resolved app theme; drives the preview's inherited text fill. */
  theme?: ResolvedTheme
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
const MIN_SPLIT_RATIO = 0.2
const MAX_SPLIT_RATIO = 0.8
const KEYBOARD_SPLIT_STEP = 0.05

export function MarkdownEditor({
  value,
  onChange,
  className,
  maxWidth = DEFAULT_MAX_WIDTH,
  previewDebounceMs = DEFAULT_PREVIEW_DEBOUNCE_MS,
  measure,
  autoFocus = false,
  theme = 'light',
}: MarkdownEditorProps) {
  const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])
  const debouncedValue = useDebouncedValue(value, previewDebounceMs)

  // Source-pane share of the split, clamped so neither pane can vanish.
  const [splitRatio, setSplitRatio] = useState(0.5)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sourceWrapRef = useRef<HTMLDivElement | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)

  const clampRatio = (ratio: number) => Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))

  const draggingRef = useRef(false)
  const onDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    draggingRef.current = true
    // Capture keeps the drag alive when the pointer outruns the 4px
    // divider; a synthetic test event has no active pointer to capture,
    // so a capture failure must not abort the drag itself.
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // draggingRef alone still tracks the gesture
    }
  }
  const onDividerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const root = rootRef.current
    if (!root) return
    const bounds = root.getBoundingClientRect()
    if (bounds.width <= 0) return
    setSplitRatio(clampRatio((event.clientX - bounds.left) / bounds.width))
  }
  const onDividerPointerUp = () => {
    draggingRef.current = false
  }
  const onDividerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? -KEYBOARD_SPLIT_STEP : KEYBOARD_SPLIT_STEP
    setSplitRatio((current) => clampRatio(current + delta))
  }

  // Proportional scroll sync, source -> preview. Line-accurate mapping
  // would need source-position anchors in the rendered SVG; the ratio map
  // keeps the preview in the neighborhood, which is what split editors
  // (VS Code's markdown preview default, HackMD) ship as their baseline.
  useEffect(() => {
    const scroller = sourceWrapRef.current?.querySelector('.cm-scroller')
    if (!(scroller instanceof HTMLElement)) return
    const onScroll = () => {
      const preview = previewScrollRef.current
      if (!preview) return
      const sourceRange = scroller.scrollHeight - scroller.clientHeight
      const previewRange = preview.scrollHeight - preview.clientHeight
      if (sourceRange <= 0 || previewRange <= 0) return
      preview.scrollTop = (scroller.scrollTop / sourceRange) * previewRange
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div
      ref={rootRef}
      className={className}
      style={{ display: 'flex', width: '100%', height: '100%', minWidth: 0 }}
    >
      <div
        ref={sourceWrapRef}
        style={{ flexBasis: `${splitRatio * 100}%`, minWidth: 0, display: 'flex' }}
      >
        <SourcePane
          value={value}
          onChange={onChange}
          autoFocus={autoFocus}
          className="markdown-editor-source"
        />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: this is the ARIA window-splitter pattern (focusable, arrow-key operable separator); an <hr> cannot take focus or a value */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize editor and preview"
        aria-valuenow={Math.round(splitRatio * 100)}
        aria-valuemin={MIN_SPLIT_RATIO * 100}
        aria-valuemax={MAX_SPLIT_RATIO * 100}
        tabIndex={0}
        data-testid="markdown-split-divider"
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
        onKeyDown={onDividerKeyDown}
        className="bg-border hover:bg-ring focus-visible:bg-ring w-1 shrink-0 cursor-col-resize"
      />
      <div
        ref={previewScrollRef}
        data-testid="markdown-preview-scroll"
        style={{ flex: 1, minWidth: 0, overflow: 'auto' }}
      >
        <PreviewPane
          value={debouncedValue}
          maxWidth={maxWidth}
          measure={resolvedMeasure}
          theme={theme}
        />
      </div>
    </div>
  )
}
