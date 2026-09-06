import { acceptCompletion, autocompletion, completionStatus } from '@codemirror/autocomplete'
import { redo, undo } from '@codemirror/commands'
import type { Extension } from '@codemirror/state'
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { MeasureText, ReferenceSeams } from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import {
  type CommentThread,
  documentIdSchema,
  type StoredCoreFacets,
} from '@kamiazya/whiteboard-model'
import { MessageSquare } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type FragmentLoaders, useMarkdownFragments } from '../../hooks/use-markdown-fragments.js'
import { useMarkdownOutline } from '../../hooks/useMarkdownOutline.js'
import type { LinkTarget } from '../../lib/link-target.js'
import type { RailBlock } from '../../lib/rail-geometry.js'
import type { PreviewBlockAnchor } from '../../lib/render-preview.js'
import type { LivePassage, TextAnchor } from '../../lib/text-anchor.js'
import type { ResolvedTheme } from '../../lib/theme.js'
import { cn } from '../../lib/utils.js'
import { ContextMenu, type ContextMenuItem } from '../spatial-editor/ContextMenu.js'
import { documentYForLine, lineForDocumentY } from './anchor-mapping.js'
import {
  annotationDecorations,
  placeThreads,
  setAnnotationProjection,
} from './annotation-decorations.js'
import { useAnnotationEntry } from './annotation-scope.js'
import { DocumentHeader } from './DocumentHeader.js'
import { EditorToolbar, type MarkdownViewMode } from './EditorToolbar.js'
import { LinkPickerDialog } from './LinkPickerDialog.js'
import { MinimapRail } from './MinimapRail.js'
import { PreviewPane } from './PreviewPane.js'
import {
  previewWidth as computePreviewWidth,
  previewColumnMaxWidth,
  RAIL_WIDTH_PX,
  railFits,
  railScrollable,
} from './preview-width.js'
import { SourcePane, type SourcePaneApi } from './SourcePane.js'
import { useDebouncedValue } from './use-debounced-value.js'
import { verbCatalogItems } from './verb-catalog.js'
import {
  wikiLinkCompletionSource,
  wikiLinkCompletionTheme,
  wikiLinkTouchAccept,
} from './wiki-link-completion.js'

export interface MarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  className?: string
  /** Upper bound for the preview's layout width in px. */
  maxWidth?: number
  /** Trailing-edge debounce delay for preview recomputation. Default 150ms. */
  previewDebounceMs?: number
  /**
   * Start in this view mode instead of the persisted per-browser preference,
   * and keep later mode changes OUT of that preference.
   *
   * A test seam, like `openWhiteboardDb(dbName?)`: production passes nothing.
   * The preference lives in localStorage, which browser test files share —
   * one origin, files in parallel — so a mount that reads it inherits
   * whatever a concurrent file last wrote, and a mount that writes it
   * poisons every concurrent reader. An explicit initial mode detaches this
   * mount from the shared preference in both directions.
   */
  initialViewMode?: MarkdownViewMode
  /** Injection seam for tests; defaults to the real Canvas 2D measurer. */
  measure?: MeasureText
  /** Focus the source pane on mount (fresh-note flows). */
  autoFocus?: boolean
  /** Resolved app theme; drives the preview's inherited text fill. */
  theme?: ResolvedTheme
  /**
   * Core OKF facets, rendered as the document header in Read mode —
   * display-only; facet editing stays in `DocumentProperties`.
   */
  meta?: StoredCoreFacets
  /**
   * The document's name, shown as the Read-mode heading. Separate from
   * `meta` because the workspace owns it (ADR-0009 decision 2).
   */
  title?: string
  /**
   * Every reference seam the preview reads — `[[path]]` aliases to ids,
   * display names for bare links, `![[embed]]` targets (a note's body or a
   * canvas) — as the one bundle canvas-render's `referenceSeams` builds
   * over what the host pre-fetched (see useReferenceSeams). Absent, only a
   * bare `[[ULID]]` resolves and every embed stays a placeholder.
   */
  references?: ReferenceSeams
  /**
   * Documents this editor may link to. Supplied by the composition root,
   * which already holds the list its switcher shows. Absent (or empty) keeps
   * the link verb's selection-free wrap: a picker onto an empty list would
   * be a dead end.
   */
  linkTargets?: readonly LinkTarget[]
  /**
   * Called with the target canvas id when a resolved wikiLink is activated
   * in the preview. The host owns navigation; without it, wikiLink anchors
   * are inert (their href is a bare ULID, not a URL).
   */
  onOpenDocument?: (documentId: string) => void
  /**
   * Injection seam for tests: the async engines behind math blocks and
   * diagram fences. Defaults to the real dynamically-imported
   * MathJax/mermaid loaders (markdown-fragment-renderers.ts).
   */
  fragmentLoaders?: FragmentLoaders
  /**
   * Host-supplied CodeMirror extensions for the source pane — the CRDT
   * binding seam (see SourcePane.extensions). When set, external `value`
   * reconciliation is disabled: the binding owns editor<->document sync
   * and `value` flows only outward (preview, word count).
   */
  sourceExtensions?: readonly Extension[]
  /**
   * The annotation layer's conversations, projected onto the body: the
   * passage each one quotes is marked in the text and named by a gutter
   * marker beside it (ADR-0026 step 3).
   *
   * Threads whose passage is gone are simply not drawn — there is nowhere
   * left to draw them — and stay reachable through the document-level rail,
   * which is what that surface is for.
   */
  threads?: readonly CommentThread[]
  /**
   * Where the CRDT still holds each passage, by thread id.
   *
   * The live half of a text anchor: a mark belongs to the characters it
   * covers, so it followed every edit that moved them — including one merged
   * from another peer, which the quote and its stored offsets can only
   * approximate. Absent for a host with none to give (a document read out of
   * a markdown file, one written before marks existed), which the projection
   * reads as "ask the quote".
   */
  threadMarks?: ReadonlyMap<string, LivePassage>
  /** The conversation the host currently has open; scrolled to and lit up. */
  selectedThreadId?: string | null
  /** A gutter marker was pressed. */
  onSelectThread?: (threadId: string) => void
  /**
   * The reader asked to open a conversation about the passage they have
   * selected. The anchor is handed over; the THREAD is not, because there is
   * no legal empty one — `commentThreadSchema` requires a first message, so
   * the conversation is created by whatever surface collects it.
   *
   * Absent means this host has no annotation layer, and the catalog then
   * offers no such row rather than an inert one.
   */
  onComposeThread?: (anchor: TextAnchor) => void
}

/** Stable identity, so the projection effect below does not fire per render. */
const NO_THREADS: readonly CommentThread[] = []
/** Same purpose as NO_THREADS, for the passages beside them. */
const NO_MARKS: ReadonlyMap<string, LivePassage> = new Map()

const DEFAULT_MAX_WIDTH = 720
const DEFAULT_PREVIEW_DEBOUNCE_MS = 150

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
 * - CRDT binding (`loro-codemirror`) is the HOST's concern, wired through
 *   `sourceExtensions`: this component stays a plain controlled
 *   `value`/`onChange` pair, and a bound host disables the value-reconcile
 *   path because the binding owns editor<->document sync.
 * - Inline `$math$` renders as plain text runs: the layout's phrasing path
 *   has no fragment seam, and a sized inline fragment inside a wrapped
 *   line is its own layout problem. Block math and mermaid fences render
 *   through useMarkdownFragments (async MathJax/mermaid behind
 *   cache-backed sync seams); until a source's first render lands, math
 *   shows the escaped-source placeholder and a fence the plain code block.
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

/**
 * Below this container width the catalog opens as a bottom sheet instead of
 * a point-anchored popover — the same breakpoint (and the same reasoning:
 * thumb reach, not screen size) the spatial canvas uses for its own ⋯.
 */
const CATALOG_SHEET_MAX_WIDTH = 768
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

/**
 * Whether an anchor href is a bare canvas id rather than a URL. Two id
 * grammars coexist by construction: the daemon mints ULIDs
 * (`documentIdSchema`), the browser store mints `crypto.randomUUID()`
 * v4 UUIDs — both reach the preview through the alias resolver.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isDocumentIdHref(href: string): boolean {
  return documentIdSchema.safeParse(href).success || UUID_PATTERN.test(href)
}

/** The laid-out document's height — the last block's bottom edge. */
function railContentHeight(blocks: readonly RailBlock[]): number {
  let bottom = 0
  for (const block of blocks) bottom = Math.max(bottom, block.y + block.h)
  return bottom
}

function totalSourceLines(value: string): number {
  return value.split('\n').length
}

/**
 * The preview DOCUMENT's own SVG — the laid-out markdown — and not merely
 * the first SVG inside the preview column.
 *
 * Four places measure their origin from it, and a bare `querySelector('svg')`
 * answers all four wrongly the moment a document has a conversation on it:
 * the comment markers live in that same column, each carries an icon, and
 * they are rendered BEFORE the pane. Measured — the query returned a marker's
 * own `viewBox="0 0 24 24"` icon, so the marker placement was reading its own
 * previous output as its origin and computed a `svgTop` of 165 where the
 * document's is 32.
 *
 * Scoped by the pane's own class rather than by DOM order, so the next
 * element added to this column cannot bring it back.
 */
function previewDocumentSvg(within: Element | null | undefined): SVGElement | null {
  const found = within?.querySelector('.markdown-preview-pane svg') ?? null
  return found instanceof SVGElement ? found : null
}

/**
 * Maps the top visible source line onto a preview scrollTop through the
 * per-block anchors, interpolating linearly inside the band between two
 * consecutive blocks (blank separator lines belong to the band above, so
 * scrolling through them eases toward the next block instead of jumping).
 * `undefined` means the anchored path cannot answer — no anchors yet, no
 * source API, no rendered SVG — and the caller keeps its proportional
 * fallback.
 */
function anchoredPreviewTop(
  anchors: readonly PreviewBlockAnchor[],
  api: SourcePaneApi | null,
  preview: HTMLElement,
  totalLines: number,
): number | undefined {
  const first = anchors[0]
  if (first === undefined || api === null || typeof api.topVisibleLine !== 'function') {
    return undefined
  }
  const svg = previewDocumentSvg(preview)
  if (svg === null) return undefined
  const line = api.topVisibleLine()
  // The SVG's own offset inside the scroll content (the document column
  // wrapper adds padding above it), measured live so pane resizes and
  // header changes never go stale.
  const svgTop =
    svg.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop
  if (line <= first.line) return svgTop + first.y * Math.max(0, line / first.line)
  let index = anchors.length - 1
  while (index > 0 && (anchors[index]?.line ?? Number.POSITIVE_INFINITY) > line) index--
  const current = anchors[index]
  if (current === undefined) return undefined
  const next = anchors[index + 1]
  const bandEndLine = next?.line ?? totalLines + 1
  const bandEndY = next?.y ?? svg.getBoundingClientRect().height
  const span = Math.max(1, bandEndLine - current.line)
  const t = Math.min(1, Math.max(0, (line - current.line) / span))
  return svgTop + current.y + t * (bandEndY - current.y)
}

export function MarkdownEditor({
  value,
  onChange,
  className,
  maxWidth = DEFAULT_MAX_WIDTH,
  previewDebounceMs = DEFAULT_PREVIEW_DEBOUNCE_MS,
  initialViewMode,
  measure,
  autoFocus = false,
  theme = 'light',
  meta,
  title,
  references,
  linkTargets,
  onOpenDocument,
  fragmentLoaders,
  sourceExtensions,
  threads,
  threadMarks,
  selectedThreadId = null,
  onSelectThread,
  onComposeThread,
}: MarkdownEditorProps) {
  const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])
  // [[ completion reads targets through a ref: the source is installed once
  // at view creation, while the document list keeps refreshing under it.
  const linkTargetsRef = useRef<readonly LinkTarget[]>(linkTargets ?? [])
  linkTargetsRef.current = linkTargets ?? []
  const completionExtension = useMemo(
    () => [
      autocompletion({
        override: [wikiLinkCompletionSource(() => linkTargetsRef.current)],
        // The upstream default (75ms) rejects an Enter that lands too soon
        // after the popup (re)opens, to protect a popup that appeared under
        // an Enter meant as a newline. This completion only ever opens
        // inside an explicit `[[` trigger, where Enter means accept — and
        // with the delay in place a fast typist's Enter fell through to the
        // markdown keymap and put a NEWLINE under the visible popup.
        interactionDelay: 0,
      }),
      // While the popup is OPEN ('active'), Enter is accept-or-nothing —
      // never a newline under a visible option list. 'pending' (the source
      // still running, typically for plain prose that will produce no
      // popup) must fall through, or Enter after typing "- item" would eat
      // the list continuation.
      Prec.highest(
        keymap.of([
          {
            key: 'Enter',
            run: (view) => {
              if (completionStatus(view.state) !== 'active') return false
              return acceptCompletion(view) || true
            },
          },
        ]),
      ),
      wikiLinkCompletionTheme,
      wikiLinkTouchAccept,
    ],
    [],
  )
  // Read through a ref for the same reason the completion source is: the
  // extension is installed once at view creation, while the handler the host
  // passes is a fresh closure on every render.
  const onSelectThreadRef = useRef(onSelectThread)
  onSelectThreadRef.current = onSelectThread
  const annotationExtension = useMemo(
    () => annotationDecorations({ onSelectThread: (id) => onSelectThreadRef.current?.(id) }),
    [],
  )
  const paneExtensions = useMemo(
    () => [completionExtension, annotationExtension, ...(sourceExtensions ?? [])],
    [annotationExtension, completionExtension, sourceExtensions],
  )
  const debouncedValue = useDebouncedValue(value, previewDebounceMs)
  // Watches the DEBOUNCED value: fragment sources only exist once the
  // preview would draw them, and rendering per raw keystroke would race
  // the engines for intermediate sources nobody will see.
  const { renderMath, renderDiagram } = useMarkdownFragments({
    body: debouncedValue,
    ...(fragmentLoaders !== undefined ? { loaders: fragmentLoaders } : {}),
  })

  // A resolved wikiLink's anchor carries a bare canvas id as its href —
  // meaningless as a URL, meaningful to the host. Intercept exactly those;
  // ordinary http(s) anchors keep default browser behavior.
  const onPreviewClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onOpenDocument) return
    const anchor = event.target instanceof Element ? event.target.closest('a') : null
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (href === null || !isDocumentIdHref(href)) return
    event.preventDefault()
    onOpenDocument(href)
  }

  const [mode, setMode] = useState<MarkdownViewMode>(() => initialViewMode ?? readStoredViewMode())
  const changeMode = (next: MarkdownViewMode) => {
    setMode(next)
    // A mount with an explicit initial mode stays detached from the shared
    // preference when the mode changes too — half an isolation (read the
    // prop, still write the store) would leave the writer side poisoning
    // concurrent mounts.
    if (initialViewMode !== undefined) return
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
  /**
   * The open catalog and where it is anchored, in coordinates relative to
   * the editor root (ContextMenu positions against its offsetParent).
   */
  // The range itself lives in the editor state (see SourcePane's pinnedRange),
  // which maps it through any edit made while the dialog is open.
  const [linkPicker, setLinkPicker] = useState<{ query: string; text: string } | null>(null)

  // The projection travels in as a STATE EFFECT rather than as an extension:
  // the view is created once per mount (see SourcePane), so an extension
  // array that changed with the thread list would never reach it.
  const projectedThreads = threads ?? NO_THREADS
  const projectedMarks = threadMarks ?? NO_MARKS
  useEffect(() => {
    sourceApiRef.current?.applyEffects([
      setAnnotationProjection.of({
        threads: projectedThreads,
        selectedThreadId,
        marks: projectedMarks,
      }),
    ])
  }, [projectedThreads, projectedMarks, selectedThreadId])

  // Scroll to the passage when the SELECTION changes, and only then. `value`
  // is a dependency because the passage's offset is derived from it, but a
  // keystroke must not re-scroll the reader back to a conversation they
  // selected a minute ago — which is what the remembered id guards.
  const revealedThreadRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = revealedThreadRef.current
    revealedThreadRef.current = selectedThreadId
    if (selectedThreadId === null || selectedThreadId === previous) return
    const placed = placeThreads(value, projectedThreads, projectedMarks).find(
      (one) => one.threadId === selectedThreadId,
    )
    // Nothing to scroll to: the passage is gone. The rail still opens the
    // conversation, which is the whole reason an orphan has a home there.
    if (placed === undefined) return
    const line = value.slice(0, placed.from).split('\n').length
    sourceApiRef.current?.revealLine(line)
  }, [selectedThreadId, projectedThreads, projectedMarks, value])
  const [catalog, setCatalog] = useState<{
    x: number
    y: number
    variant: 'grid' | 'sheet' | 'list'
  } | null>(null)
  // Filled by PreviewPane on every render; read lazily by the scroll handler.
  const anchorsRef = useRef<readonly PreviewBlockAnchor[]>([])
  const blocksRef = useRef<readonly RailBlock[]>([])
  // The rail needs to RE-RENDER as the preview scrolls and as its blocks
  // change, so unlike the anchors — read imperatively inside a scroll
  // handler — these have to be state.
  const [railBlocks, setRailBlocks] = useState<readonly RailBlock[]>([])
  /**
   * The annotation layer's projection onto the PREVIEW: one marker beside
   * the laid-out block a thread's passage starts in, at the y the rail's
   * own line-to-document mapping gives that line. A highlight over the
   * exact words would need canvas-render to know about this document's
   * threads; the block marker is what the layout already answers, and it
   * is enough to find a conversation while reading.
   */
  const [previewMarkers, setPreviewMarkers] = useState<
    readonly {
      readonly threadId: string
      readonly top: number
      readonly selected: boolean
      readonly messages: number
    }[]
  >([])
  const previewInnerRef = useRef<HTMLDivElement | null>(null)
  const [railViewport, setRailViewport] = useState({ top: 0, height: 0 })
  // Whether the pane the rail maps has anything to scroll. Read from the same
  // element on the same tick as the viewport above, for the same reason.
  const [railHasScroll, setRailHasScroll] = useState(false)

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

  // Scroll sync, source -> preview. Line-accurate: the preview render
  // reports each top-level block's source start line and laid-out Y (see
  // render-preview.ts), so the top visible source line maps onto the
  // block band it falls in, interpolated linearly inside the band. The
  // proportional ratio map stays as the fallback for the moments anchors
  // are unavailable (unparseable mid-edit body, first render) — it keeps
  // the preview in the neighborhood, which is what split editors (VS
  // Code's markdown preview default, HackMD) ship as their baseline.
  useEffect(() => {
    const scroller = sourceWrapRef.current?.querySelector('.cm-scroller')
    if (!(scroller instanceof HTMLElement)) return
    const onScroll = () => {
      const preview = previewScrollRef.current
      if (!preview) return
      const anchored = anchoredPreviewTop(
        anchorsRef.current,
        sourceApiRef.current,
        preview,
        totalSourceLines(value),
      )
      if (anchored !== undefined) {
        preview.scrollTop = anchored
        return
      }
      const sourceRange = scroller.scrollHeight - scroller.clientHeight
      const previewRange = preview.scrollHeight - preview.clientHeight
      if (sourceRange <= 0 || previewRange <= 0) return
      preview.scrollTop = (scroller.scrollTop / sourceRange) * previewRange
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [value])

  // Write mode has no preview on screen, so the rail drives the SOURCE:
  // a press is a document position, and the anchors say which line that is.
  const seekSource = useCallback(
    (documentY: number) => {
      const api = sourceApiRef.current
      if (api === null) return
      api.revealLine(
        lineForDocumentY(anchorsRef.current, documentY, {
          totalLines: totalSourceLines(value),
          contentHeight: railContentHeight(blocksRef.current),
        }),
      )
    },
    [value],
  )

  const seekPreview = useCallback((documentY: number) => {
    const preview = previewScrollRef.current
    if (preview === null) return
    const svg = previewDocumentSvg(preview)
    const svgTop =
      svg === null
        ? 0
        : svg.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop
    // Centre what was pointed at, the way a minimap press does — landing it
    // at the very top would hide the context just above it.
    preview.scrollTop = svgTop + documentY - preview.clientHeight / 2
  }, [])

  // Layout width the preview typesets at: what the pane can actually offer
  // (minus the document column's padding), clamped to a readable measure —
  // see preview-width.ts, which owns the arithmetic and the reasons.
  //
  // The rail is a sibling of the preview, so the width it occupies is width
  // the preview does not get. Typesetting against the container's full width
  // instead overflows by exactly the rail — the document is then clipped at
  // the very edge the rail is drawn on.
  const railAffordable = railFits(containerWidth)
  const railWidth =
    railAffordable && effectiveMode !== 'write' && debouncedValue.trim() !== '' ? RAIL_WIDTH_PX : 0
  const previewWidth = computePreviewWidth({
    containerWidth,
    maxWidth,
    railWidth,
    splitRatio,
    mode: effectiveMode,
  })

  /**
   * Keeps the rail in step with the preview it maps.
   *
   * Both halves are read from the SAME element on the same tick: the blocks
   * live in the SVG's pixel space, so the visible slice has to be expressed
   * there too, which means subtracting the SVG's own offset inside the
   * scroll content. Measured live rather than cached, because the document
   * column's padding and header change it.
   */
  /**
   * Write mode has no preview, so nothing lays the document out — and the
   * rail would otherwise show whatever the last preview produced, going
   * stale with every keystroke. The shared hook lays it out in the pool
   * instead, at background priority.
   */
  const writeModeOutline = useMarkdownOutline(debouncedValue, {
    enabled: effectiveMode === 'write',
    maxWidth: previewWidth,
  })
  useEffect(() => {
    // Only a shape computed for THIS text. The hook keeps its last result
    // across a disable so the rail does not blink, which means the first
    // render after re-entering write mode offers the shape of whatever was
    // there before — and a seek through those anchors reveals the wrong
    // line.
    if (effectiveMode !== 'write' || writeModeOutline.forBody !== debouncedValue) return
    anchorsRef.current = writeModeOutline.anchors
    blocksRef.current = writeModeOutline.blocks
    setRailBlocks(writeModeOutline.blocks)
  }, [effectiveMode, writeModeOutline, debouncedValue])

  // Write mode: the visible SOURCE lines are what the marker has to show, so
  // the range is read from CodeMirror's own block geometry and mapped onto
  // the laid-out document the bars describe.
  useEffect(() => {
    if (effectiveMode !== 'write') return
    const scroller = sourceWrapRef.current?.querySelector('.cm-scroller')
    if (!(scroller instanceof HTMLElement)) return
    const sync = () => {
      const api = sourceApiRef.current
      if (api === null) return
      const blocks = blocksRef.current
      const tail = {
        totalLines: totalSourceLines(value),
        contentHeight: railContentHeight(blocks),
      }
      const top = documentYForLine(anchorsRef.current, api.topVisibleLine(), tail)
      const bottom = documentYForLine(anchorsRef.current, api.bottomVisibleLine(), tail)
      setRailViewport({ top, height: Math.max(0, bottom - top) })
      setRailHasScroll(
        railScrollable({
          contentHeight: scroller.scrollHeight,
          viewportHeight: scroller.clientHeight,
        }),
      )
      setRailBlocks(blocks)
    }
    sync()
    scroller.addEventListener('scroll', sync, { passive: true })
    return () => scroller.removeEventListener('scroll', sync)
    // writeModeOutline belongs here: new rows arriving without a matching
    // viewport recomputation leaves the marker placed by the PREVIOUS
    // layout until the user happens to scroll.
  }, [effectiveMode, value, debouncedValue, writeModeOutline])

  useEffect(() => {
    const preview = previewScrollRef.current
    if (preview === null) return
    const sync = () => {
      const svg = previewDocumentSvg(preview)
      const svgTop =
        svg === null
          ? 0
          : svg.getBoundingClientRect().top -
            preview.getBoundingClientRect().top +
            preview.scrollTop
      setRailViewport({ top: preview.scrollTop - svgTop, height: preview.clientHeight })
      setRailHasScroll(
        railScrollable({
          contentHeight: preview.scrollHeight,
          viewportHeight: preview.clientHeight,
        }),
      )
      setRailBlocks(blocksRef.current)
    }
    sync()
    preview.addEventListener('scroll', sync, { passive: true })
    return () => preview.removeEventListener('scroll', sync)
    // previewWidth belongs here: a resize re-typesets the document and
    // changes every block, and debouncedValue does NOT change with it —
    // reading the ref without it leaves the rail describing the layout the
    // previous width produced.
  }, [effectiveMode, debouncedValue, previewWidth])

  // Keyed on railBlocks because that is the state the preview's render
  // updates: the anchors it maps through arrive in the same ref write.
  // Placement goes through `placeThreads`, the same reader the source pane
  // and the rail use, so a thread the rail calls lost gets no marker.
  useEffect(() => {
    if (effectiveMode === 'write' || projectedThreads.length === 0) {
      setPreviewMarkers([])
      return
    }
    const inner = previewInnerRef.current
    const svg = previewDocumentSvg(inner)
    if (inner === null || svg === null) {
      setPreviewMarkers([])
      return
    }
    const svgTop = svg.getBoundingClientRect().top - inner.getBoundingClientRect().top
    const tail = {
      totalLines: totalSourceLines(debouncedValue),
      contentHeight: railContentHeight(blocksRef.current),
    }
    // Read from the projection by id: `PlacedThread` answers WHERE a passage
    // is, and how many messages it holds is not a property of that.
    const messageCounts = new Map(projectedThreads.map((one) => [one.id, one.messages.length]))
    setPreviewMarkers(
      placeThreads(debouncedValue, projectedThreads, projectedMarks).map((placed) => ({
        threadId: placed.threadId,
        messages: messageCounts.get(placed.threadId) ?? 1,
        top:
          svgTop +
          documentYForLine(
            anchorsRef.current,
            debouncedValue.slice(0, placed.from).split('\n').length,
            tail,
          ),
        selected: placed.threadId === selectedThreadId,
      })),
    )
  }, [
    effectiveMode,
    railBlocks,
    projectedThreads,
    projectedMarks,
    debouncedValue,
    selectedThreadId,
  ])

  const openCatalogAt = useCallback(
    (clientX: number, clientY: number, variant: 'grid' | 'list') => {
      const rect = rootRef.current?.getBoundingClientRect()
      // Same container breakpoint the canvas uses to choose its vessel:
      // below it the catalog is a bottom sheet with thumb-sized targets,
      // above it the point-anchored popover the pointer expects.
      const narrow = containerWidth !== null && containerWidth < CATALOG_SHEET_MAX_WIDTH
      setCatalog({
        x: clientX - (rect?.left ?? 0),
        y: clientY - (rect?.top ?? 0),
        variant: narrow ? 'sheet' : variant,
      })
    },
    [containerWidth],
  )

  // A right-click WITH a selection is a request to act on it, and that is
  // exactly this catalog. With nothing selected the platform's own menu
  // (spellcheck, dictionary, translate) is worth more than ours, so the
  // event is left alone. Bound natively rather than through a JSX prop: the
  // source pane is a plain container, and giving it a widget role to satisfy
  // an interactive-element lint would misdescribe it to a screen reader.
  useEffect(() => {
    const host = sourceWrapRef.current
    if (host === null) return
    const onContextMenu = (event: MouseEvent) => {
      if (window.getSelection()?.isCollapsed !== false) return
      event.preventDefault()
      openCatalogAt(event.clientX, event.clientY, 'list')
    }
    host.addEventListener('contextmenu', onContextMenu)
    return () => host.removeEventListener('contextmenu', onContextMenu)
  }, [openCatalogAt])

  const annotation = useAnnotationEntry(value, sourceApiRef, {
    threads: projectedThreads,
    marks: projectedMarks,
    onComposeThread,
    onSelectThread,
  })

  const catalogItems = useMemo((): readonly ContextMenuItem[] => {
    // Deliberately outside MARKDOWN_EDITOR_VERBS, which is the closed set of
    // things that write MARKUP into the body: Comment writes nothing there
    // at all, it opens a conversation in the layer beside it. Putting it in
    // that table would give the keymap a shortcut for it and the verb bar a
    // button, both of which would then have to resolve a scope the table
    // cannot describe.
    return verbCatalogItems({
      headingLevel: sourceApiRef.current?.headingLevel() ?? 0,
      run: (command) => sourceApiRef.current?.run(command),
      close: () => setCatalog(null),
      ...(linkTargets !== undefined && linkTargets.length > 0
        ? {
            openLinkPicker: () => {
              const scope = sourceApiRef.current?.pinScope()
              if (scope === undefined) return
              setLinkPicker({ query: scope.text, text: scope.text })
            },
          }
        : {}),
      ...(annotation.open !== undefined && annotation.anchor() !== null
        ? { composeThread: annotation.open }
        : {}),
    })
    // `catalog` is read so the rows are rebuilt on each opening: the
    // selection they describe is the one at THAT moment.
  }, [annotation, catalog, linkTargets, value])

  const wordCount = useMemo(() => countWords(debouncedValue), [debouncedValue])
  const previewEmpty = debouncedValue.trim() === ''

  return (
    <div ref={rootRef} className={cn('relative flex h-full w-full min-w-0 flex-col', className)}>
      <EditorToolbar
        // The EFFECTIVE mode, not the stored preference: on a narrow
        // container a stored 'split' renders as Write, and the toolbar's
        // active state (and aria-pressed) must describe what is on screen.
        mode={effectiveMode}
        onModeChange={changeMode}
        splitAvailable={splitAvailable}
        wordCount={wordCount}
        onOpenCatalog={({ x, y }) => openCatalogAt(x, y, 'grid')}
        catalogAvailable={effectiveMode !== 'read'}
        onComment={annotation.open}
        commentAvailable={value.trim() !== ''}
        runVerb={(command) => {
          sourceApiRef.current?.run(command)
        }}
        openLinkPicker={() => {
          if (linkTargets === undefined || linkTargets.length === 0) return false
          const scope = sourceApiRef.current?.pinScope()
          if (scope === undefined) return false
          setLinkPicker({ query: scope.text, text: scope.text })
          return true
        }}
        {...(effectiveMode === 'read'
          ? {}
          : {
              // The step pair runs through the same `run(command)` seam the
              // catalog's verbs do — undo is an ordinary CodeMirror command,
              // so it needs no API of its own.
              onUndo: () => {
                sourceApiRef.current?.run(undo)
              },
              onRedo: () => {
                sourceApiRef.current?.run(redo)
              },
            })}
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
            onRequestLinkPicker={
              linkTargets !== undefined && linkTargets.length > 0
                ? () => {
                    const scope = sourceApiRef.current?.pinScope()
                    if (scope === undefined) return false
                    setLinkPicker({ query: scope.text, text: scope.text })
                    return true
                  }
                : undefined
            }
            apiRef={sourceApiRef}
            placeholderText="Write in Markdown…"
            className="markdown-editor-source"
            extensions={paneExtensions}
            // A CRDT binding owns editor<->document sync; the controlled
            // reconcile path would race it (see SourcePane).
            reconcileExternalValue={sourceExtensions === undefined}
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
            <div
              ref={previewInnerRef}
              className="relative mx-auto px-6 py-8"
              style={{ maxWidth: previewColumnMaxWidth(previewWidth) }}
            >
              {previewMarkers.map((marker) => (
                <button
                  key={marker.threadId}
                  type="button"
                  data-testid="comment-preview-marker"
                  data-thread-id={marker.threadId}
                  aria-label={
                    marker.messages > 1
                      ? `Open comment, ${marker.messages} messages`
                      : 'Open comment'
                  }
                  onClick={() => onSelectThread?.(marker.threadId)}
                  // In the column's own left padding, on the block's top edge.
                  style={{ top: marker.top }}
                  className={cn(
                    'absolute left-0 flex size-6 items-center justify-center rounded text-(--annotation) hover:bg-accent',
                    marker.selected && 'bg-accent',
                  )}
                >
                  <MessageSquare
                    aria-hidden="true"
                    className="size-3.5"
                    fill={marker.selected ? 'currentColor' : 'none'}
                    fillOpacity={0.35}
                  />
                  {/* Only past one. Read mode never shows the source, so this
                      marker is all a reader has to judge a conversation by —
                      but a digit beside every lone remark is noise, and the
                      badge only says something once there is more than one.
                      Corner-set rather than beside the icon: the column's
                      left padding is exactly this button's width, so growing
                      it sideways would run under the prose. */}
                  {marker.messages > 1 ? (
                    <span className="pointer-events-none absolute -top-0.5 -right-0.5 rounded-full bg-(--annotation) px-1 text-[9px] leading-[12px] text-background">
                      {marker.messages}
                    </span>
                  ) : null}
                </button>
              ))}
              {effectiveMode === 'read' && meta !== undefined && (
                <DocumentHeader title={title} meta={meta} />
              )}
              {previewEmpty ? (
                <p className="text-muted-foreground text-sm">Nothing to preview yet.</p>
              ) : (
                <PreviewPane
                  value={debouncedValue}
                  maxWidth={previewWidth}
                  measure={resolvedMeasure}
                  theme={theme}
                  references={references}
                  renderMath={renderMath}
                  renderDiagram={renderDiagram}
                  anchorsRef={anchorsRef}
                  blocksRef={blocksRef}
                />
              )}
            </div>
          </div>
        )}
        {!previewEmpty && railAffordable && railHasScroll && railBlocks.length > 0 && (
          // The bars are the same in every mode — they describe the document,
          // not the pane. Only what a press moves differs: the preview when
          // one is on screen, otherwise the source through its anchors.
          //
          // Gated on having blocks because they come from the preview's
          // layout, and write mode renders no preview: the rail there shows
          // whatever the last preview produced, and shows NOTHING at all in a
          // session that never left write mode. An empty strip claims the
          // document has no shape, which is worse than no rail. Laying the
          // document out for the rail when no preview is running is the
          // worker pool's job — the increment after this one.
          <MinimapRail
            blocks={railBlocks}
            viewport={railViewport}
            onSeek={effectiveMode === 'write' ? seekSource : seekPreview}
          />
        )}
      </div>
      {linkPicker !== null && linkTargets !== undefined && (
        <LinkPickerDialog
          targets={linkTargets}
          initialQuery={linkPicker.query}
          linkText={linkPicker.text}
          onPick={(markup) => {
            sourceApiRef.current?.replacePinned(markup)
            setLinkPicker(null)
          }}
          onCancel={() => {
            setLinkPicker(null)
            sourceApiRef.current?.clearPin()
            sourceApiRef.current?.focus()
          }}
        />
      )}
      {catalog !== null && (
        <ContextMenu
          x={catalog.x}
          y={catalog.y}
          variant={catalog.variant}
          items={catalogItems}
          onClose={() => setCatalog(null)}
        />
      )}
    </div>
  )
}
