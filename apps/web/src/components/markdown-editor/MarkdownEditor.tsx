import type { AliasResolver } from '@kamiazya/whiteboard-canvas-codec'
import { type CanvasCoreMeta, canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { cn } from '../../lib/utils.js'
import { DocumentHeader } from './DocumentHeader.js'
import { EditorToolbar, type MarkdownViewMode } from './EditorToolbar.js'
import { PreviewPane } from './PreviewPane.js'
import { SourcePane, type SourcePaneApi } from './SourcePane.js'
import { useDebouncedValue } from './use-debounced-value.js'

export interface MarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  className?: string
  /** Upper bound for the preview's layout width in px. */
  maxWidth?: number
  /** Trailing-edge debounce delay for preview recomputation. Default 150ms. */
  previewDebounceMs?: number
  /** Injection seam for tests; defaults to the real Canvas 2D measurer. */
  measure?: MeasureText
  /** Focus the source pane on mount (fresh-note flows). */
  autoFocus?: boolean
  /** Resolved app theme; drives the preview's inherited text fill. */
  theme?: ResolvedTheme
  /**
   * Core OKF facets, rendered as the document header in Read mode —
   * display-only; facet editing stays in `CanvasProperties`.
   */
  meta?: CanvasCoreMeta
  /**
   * Maps `[[Name]]` aliases to canvas ids for the preview (canvas-codec's
   * separate resolution pass). Absent, only `[[canvas:ULID]]` resolves.
   */
  resolveAlias?: AliasResolver
  /**
   * Called with the target canvas id when a resolved wikiLink is activated
   * in the preview. The host owns navigation; without it, wikiLink anchors
   * are inert (their href is a bare ULID, not a URL).
   */
  onOpenCanvas?: (canvasId: string) => void
}

const DEFAULT_MAX_WIDTH = 720
const DEFAULT_PREVIEW_DEBOUNCE_MS = 150
const MIN_PREVIEW_WIDTH = 320

/**
 * A controlled markdown editor: one source-of-truth `value` string, edited
 * through a CodeMirror 6 source pane and previewed through
 * `renderMarkdownPreviewSvg` — the same parse -> layout -> SVG path the
 * spatial canvas's text node and export use, so there is no second
 * markdown-to-HTML renderer to drift from it.
 *
 * Three view modes (Write / Split / Read), persisted per browser. Read
 * HIDES the source pane instead of unmounting it, so the CodeMirror undo
 * history survives a Read -> Write round trip. Split needs room for two
 * columns; a container narrower than `SPLIT_MIN_WIDTH` falls back to Write
 * without overwriting the stored preference.
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
const SPLIT_MIN_WIDTH = 640
const VIEW_MODE_STORAGE_KEY = 'whiteboard.markdown-view-mode'

function isViewMode(value: unknown): value is MarkdownViewMode {
  return value === 'write' || value === 'split' || value === 'read'
}

function readStoredViewMode(): MarkdownViewMode {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)
    return isViewMode(stored) ? stored : 'split'
  } catch {
    return 'split'
  }
}

function countWords(value: string): number {
  return (value.match(/[\p{L}\p{N}]+/gu) ?? []).length
}

export function MarkdownEditor({
  value,
  onChange,
  className,
  maxWidth = DEFAULT_MAX_WIDTH,
  previewDebounceMs = DEFAULT_PREVIEW_DEBOUNCE_MS,
  measure,
  autoFocus = false,
  theme = 'light',
  meta,
  resolveAlias,
  onOpenCanvas,
}: MarkdownEditorProps) {
  const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])
  const debouncedValue = useDebouncedValue(value, previewDebounceMs)

  // A resolved wikiLink's anchor carries a bare canvas id as its href —
  // meaningless as a URL, meaningful to the host. Intercept exactly those;
  // ordinary http(s) anchors keep default browser behavior.
  const onPreviewClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onOpenCanvas) return
    const anchor = event.target instanceof Element ? event.target.closest('a') : null
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (href === null || !canvasIdSchema.safeParse(href).success) return
    event.preventDefault()
    onOpenCanvas(href)
  }

  const [mode, setMode] = useState<MarkdownViewMode>(readStoredViewMode)
  const changeMode = (next: MarkdownViewMode) => {
    setMode(next)
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, next)
    } catch {
      // Preference persistence is best-effort; the session state still works.
    }
  }

  // Source-pane share of the split, clamped so neither pane can vanish.
  const [splitRatio, setSplitRatio] = useState(0.5)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sourceWrapRef = useRef<HTMLDivElement | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)
  const sourceApiRef = useRef<SourcePaneApi | null>(null)

  // Container width drives the split fallback and the preview's adaptive
  // layout width. `null` (pre-observation, or jsdom without ResizeObserver)
  // is treated as wide, matching the split-by-default contract the existing
  // tests pin.
  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined && width > 0) setContainerWidth(width)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  const splitAvailable = containerWidth === null || containerWidth >= SPLIT_MIN_WIDTH
  const effectiveMode: MarkdownViewMode = mode === 'split' && !splitAvailable ? 'write' : mode

  const clampRatio = (ratio: number) => Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))

  const draggingRef = useRef(false)
  const onDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    draggingRef.current = true
    // Capture keeps the drag alive when the pointer outruns the divider;
    // a synthetic test event has no active pointer to capture, so a
    // capture failure must not abort the drag itself.
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

  // Layout width the preview typesets at: what the pane can actually offer
  // (minus the document column's padding), clamped to a readable measure.
  const horizontalPadding = 48
  const paneWidth =
    containerWidth === null
      ? maxWidth
      : effectiveMode === 'split'
        ? containerWidth * (1 - splitRatio)
        : containerWidth
  // Quantized so a divider drag re-typesets the whole document at 64px
  // steps instead of on every pointermove.
  const previewWidth = Math.max(
    MIN_PREVIEW_WIDTH,
    Math.min(maxWidth, Math.round((paneWidth - horizontalPadding) / 64) * 64),
  )

  const wordCount = useMemo(() => countWords(debouncedValue), [debouncedValue])
  const previewEmpty = debouncedValue.trim() === ''

  return (
    <div ref={rootRef} className={cn('flex h-full w-full min-w-0 flex-col', className)}>
      <EditorToolbar
        // The EFFECTIVE mode, not the stored preference: on a narrow
        // container a stored 'split' renders as Write, and the toolbar's
        // active state (and aria-pressed) must describe what is on screen.
        mode={effectiveMode}
        onModeChange={changeMode}
        splitAvailable={splitAvailable}
        wordCount={wordCount}
        formattingEnabled={effectiveMode !== 'read'}
        onFormat={(delimiter) => sourceApiRef.current?.wrapSelection(delimiter)}
      />
      <div className="flex min-h-0 flex-1">
        <div
          ref={sourceWrapRef}
          data-testid="markdown-source-wrap"
          style={{
            display: effectiveMode === 'read' ? 'none' : 'flex',
            flexBasis: effectiveMode === 'split' ? `${splitRatio * 100}%` : '100%',
            minWidth: 0,
          }}
        >
          <SourcePane
            value={value}
            onChange={onChange}
            autoFocus={autoFocus}
            apiRef={sourceApiRef}
            placeholderText="Write in Markdown…"
            className="markdown-editor-source"
          />
        </div>
        {effectiveMode === 'split' && (
          // biome-ignore lint/a11y/useSemanticElements: this is the ARIA window-splitter pattern (focusable, arrow-key operable separator); an <hr> cannot take focus or a value
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
            className="bg-border hover:bg-ring focus-visible:bg-ring w-1 shrink-0 cursor-col-resize touch-none transition-colors duration-(--motion-duration-fast) focus-visible:outline-none"
          />
        )}
        {effectiveMode !== 'write' && (
          // biome-ignore lint/a11y/noStaticElementInteractions: delegation for the SVG's native <a> elements — a focused anchor's Enter already dispatches the click this handler receives, so the keyboard path lives on the anchor, not this container
          // biome-ignore lint/a11y/useKeyWithClickEvents: same rationale — the interactive element is the anchor inside, which is natively keyboard-activatable
          <div
            ref={previewScrollRef}
            data-testid="markdown-preview-scroll"
            className="min-w-0 flex-1 overflow-auto"
            onClick={onPreviewClick}
          >
            <div className="mx-auto px-6 py-8" style={{ maxWidth: previewWidth + 48 }}>
              {effectiveMode === 'read' && meta !== undefined && <DocumentHeader meta={meta} />}
              {previewEmpty ? (
                <p className="text-muted-foreground text-sm">Nothing to preview yet.</p>
              ) : (
                <PreviewPane
                  value={debouncedValue}
                  maxWidth={previewWidth}
                  measure={resolvedMeasure}
                  theme={theme}
                  resolveAlias={resolveAlias}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
