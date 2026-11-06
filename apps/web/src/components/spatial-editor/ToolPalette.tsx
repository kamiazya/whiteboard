/**
 * Bottom dock — the ONE container for all bottom-anchored canvas chrome.
 *
 * Two layout decisions, both recorded after real collisions:
 * - Host controls (undo/redo/version history) join this container through
 *   the `leading` slot instead of floating as independently positioned
 *   islands — independent islands collide as tools grow (the 2026-08-08
 *   phone overlap).
 * - Creation tools live in a "+" menu, not as one flat button per type
 *   (the tldraw/FigJam shape, user decision 2026-08-08): the dock keeps a
 *   FIXED small button set, and new node types extend the menu, never the
 *   dock's width. Where one row cannot hold every control whole (a phone at
 *   the touch size), the tools fold onto a second row rather than scrolling.
 *
 * Design rule (ADR-0006, docs/contributing/adr/0006-object-oriented-ui.md):
 * what does NOT exist yet comes from the palette; what already exists is
 * acted on from the object itself. The "+" menu is the palette's creation
 * surface — it must never grow per-object actions.
 *
 * Icon-only dock buttons keep their accessible names via aria-label; the
 * "+" menu's entries show icon AND label (a creation menu is a reading
 * surface, not a memorized strip). Scope note: this labels-on rule covers
 * CREATION surfaces only — object-action surfaces are icon-first by
 * design (see DESIGN.md, "Object-action surfaces are icon-first").
 *
 * Marked `data-editor-overlay` so the canvas root's gesture handlers
 * ignore presses originating here (see SpatialEditor's isOverlayEvent).
 */
import {
  CircleHelp,
  Eraser,
  FileBox,
  Focus,
  Frame,
  Hand,
  Image as ImageIcon,
  Link,
  MousePointer2,
  Pencil,
  Plus,
  Spline,
  StickyNote,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { DOCK_BUTTON_CLASS, TOGGLE_STATE_CLASS } from '../../components/ui/dock-button.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js'
import type { EditorTool } from '../../lib/editor-tool.js'
import { hasCoarsePointer } from '../../lib/platform.js'
import { cn } from '../../lib/utils.js'
import { useActiveMarkdownEditor } from '../markdown-editor/active-markdown-editor.js'
import { touchFormattingBarShown } from '../markdown-editor/verb-bar-layout.js'
import { CREATION_LABELS } from './creation-labels.js'
import { ShortcutHelpSheet } from './ShortcutHelpSheet.js'
import { shortcutAriaKeysFor, withShortcut } from './shortcut-labels.js'
import { useReturnFocusWhenClosed } from './use-canvas-focus-return.js'
import type { ShortcutHelpControl } from './use-shortcut-help.js'
import { useStackWhenCramped } from './use-stack-when-cramped.js'

/**
 * Drag payload for placing a creation where it is dropped: the kind travels
 * in the MIME TYPE, not in the data.
 *
 * Two reasons it is shaped this way. A custom type rather than `text/plain`,
 * because the canvas already turns foreign text drops into notes and the two
 * must not be confused. And the kind in the type rather than in the value,
 * because a drag data store is in protected mode for everything except
 * `dragstart` — `getData` reads back empty at the drop, while `types` stays
 * readable throughout.
 */
const CREATE_DRAG_MIME_PREFIX = 'application/x-whiteboard-create+'

/** The kind carried by a drag, or null when the drag is not one of ours. */
export function draggedCreation(types: readonly string[]): DraggableCreation | null {
  const type = types.find((t) => t.startsWith(CREATE_DRAG_MIME_PREFIX))
  if (type === undefined) return null
  const kind = type.slice(CREATE_DRAG_MIME_PREFIX.length)
  return kind === 'note' || kind === 'group' ? kind : null
}
/** Creations that place directly, so a drop point is all they need. */
export type DraggableCreation = 'note' | 'group'

interface ToolPaletteProps {
  /** Host-supplied controls (undo/redo/versions) docked as the leading group. */
  readonly leading?: ReactNode
  readonly onCreateNode: () => void
  readonly onCreateLink: () => void
  readonly onCreateGroup: () => void
  /** Absent when the host supplies no canvas listing — the entry hides. */
  readonly onCreateDocumentRef?: () => void
  /** Absent when the host supplies no image storage — the entry hides. */
  readonly onCreateImage?: () => void
  readonly tool: EditorTool
  readonly onToolChange: (tool: EditorTool) => void
  /** Frames every node in the viewport — the touch equivalent of Shift+1. */
  readonly onZoomToFit: () => void
  /**
   * One step closer or further, the same step the `+` / `-` keys take. Touch
   * only: pinch is otherwise the single way to get closer on a phone, while a
   * pointer has the wheel and the keyboard. Absent hides the pair.
   */
  readonly onZoomStep?: (direction: 'in' | 'out') => void
  /** The shortcut sheet's open state; absent hides the dock's Help button. */
  readonly shortcutHelp?: ShortcutHelpControl
  /** Puts the keyboard back on the canvas when the Add menu closes and nothing else took it. */
  readonly onReturnFocus?: () => void
}

/**
 * Vertical strip of the canvas a ONE-ROW dock covers: its own height plus
 * the `bottom-3` offset, with room so a revealed node clears it rather than
 * touching it. The floor of `bottomChromeOcclusionPx`, which measures the
 * rest. Pinned against the real rendered height by
 * bottom-dock.browser.test.tsx, which is what stops it drifting when the
 * dock's classes change.
 */
const DOCK_OCCLUSION_PX = 70

/**
 * The chrome along the editor's bottom edge that a placed, revealed or
 * fitted node must clear: the dock, the Draw options standing above it, and
 * the overview's corner button on a narrow editor — a node brought into view
 * under that button has its resize handle beneath it.
 */
const BOTTOM_CHROME =
  '[data-testid="tool-palette"], [data-testid="draw-options"], [data-testid="minimap-toggle-wrap"]'

/** Room kept between a node brought into view and the chrome along the bottom edge. */
const BOTTOM_CHROME_GAP_PX = 12

/**
 * The strip along the bottom of `root` that chrome paints over, measured: a
 * dock folded onto two rows on a phone, the Draw options and the overview's
 * button above it, stand far higher than DOCK_OCCLUSION_PX, which stays the
 * floor — the one-row dock's strip, and the answer wherever nothing can be
 * measured.
 */
export function bottomChromeOcclusionPx(root: HTMLElement | null): number {
  if (root === null) return DOCK_OCCLUSION_PX
  const floor = root.getBoundingClientRect().bottom
  let covered = DOCK_OCCLUSION_PX
  for (const chrome of root.querySelectorAll<HTMLElement>(BOTTOM_CHROME)) {
    const its = chrome.getBoundingClientRect()
    if (its.height === 0) continue
    covered = Math.max(covered, floor - its.top + BOTTOM_CHROME_GAP_PX)
  }
  return covered
}

export const TOOL_BUTTON_CLASS = `${DOCK_BUTTON_CLASS} ${TOGGLE_STATE_CLASS}`

/** A group of dock controls: transparent to the one-row flex, a grid cell once the dock folds. */
const STACKED_CELL_CLASS =
  'contents group-data-stacked:flex group-data-stacked:items-center group-data-stacked:gap-0.5'

/** Whether the tools would have to scroll to share the dock's single row. */
function toolsCramped(dock: HTMLElement): boolean {
  const tools = dock.querySelector<HTMLElement>('[data-dock-tools]')
  return tools !== null && tools.scrollWidth > tools.clientWidth + 0.5
}

/**
 * The entry a menu key moves focus to (Up/Down wrap, Home/End jump), or null
 * for a key that does not move it.
 */
function menuFocusTarget(
  key: string,
  items: readonly HTMLElement[],
  active: Element | null,
): HTMLElement | null {
  if (items.length === 0) return null
  const at = active instanceof HTMLElement ? items.indexOf(active) : -1
  if (key === 'Home') return items[0] ?? null
  if (key === 'End') return items[items.length - 1] ?? null
  if (key === 'ArrowDown') return items[(at + 1) % items.length] ?? null
  if (key === 'ArrowUp') return items[(at <= 0 ? items.length : at) - 1] ?? null
  return null
}

interface AddMenuEntry {
  readonly label: string
  readonly icon: ReactNode
  readonly onSelect: () => void
  /**
   * Present when the entry can be dragged onto the canvas to choose its
   * place. Absent for entries that open a dialog or a picker first — there
   * is nothing to place until that returns.
   */
  readonly drag?: DraggableCreation
}

function ZoomFitButton({ onZoomToFit }: { readonly onZoomToFit: () => void }) {
  // The only view control in the dock. People ask to "see everything" or to
  // "get closer"; the magnification between those two is an implementation
  // coordinate, so no percentage is offered and there is nothing to reset to.
  // Getting closer is a double press in hand mode (and the wheel/pinch), which
  // needs no chrome at all.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="zoom-fit-button"
          aria-label="Zoom to fit"
          aria-keyshortcuts={shortcutAriaKeysFor('zoom-to-fit')}
          // Wrapped: a bare handler reference hands React's click event to
          // the callback, and this one takes an optional id set.
          onClick={() => onZoomToFit()}
          className={TOOL_BUTTON_CLASS}
        >
          <Focus aria-hidden="true" className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{withShortcut('Zoom to fit', 'zoom-to-fit')}</TooltipContent>
    </Tooltip>
  )
}

function ZoomStepButtons({ onZoomStep }: { readonly onZoomStep?: (d: 'in' | 'out') => void }) {
  if (onZoomStep === undefined || !hasCoarsePointer()) return null
  const steps = [
    { direction: 'in', id: 'zoom-in', label: 'Zoom in', Icon: ZoomIn },
    { direction: 'out', id: 'zoom-out', label: 'Zoom out', Icon: ZoomOut },
  ] as const
  return (
    <>
      {steps.map(({ direction, id, label, Icon }) => (
        <Tooltip key={id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid={`${id}-button`}
              aria-label={label}
              aria-keyshortcuts={shortcutAriaKeysFor(id)}
              onClick={() => onZoomStep(direction)}
              className={TOOL_BUTTON_CLASS}
            >
              <Icon aria-hidden="true" className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{withShortcut(label, id)}</TooltipContent>
        </Tooltip>
      ))}
    </>
  )
}

/**
 * The Help button, and the sheet it opens. A corner of its own rather than a
 * dock slot: one more dock button widens the dock into the minimap at tablet
 * widths, and the bottom edge has no spare room at phone widths. Hidden on
 * touch, where there is no keyboard to learn.
 */
function ShortcutsButton({ open, onOpenChange }: ShortcutHelpControl) {
  return (
    <div
      data-editor-overlay
      className="absolute top-3 left-3 z-10 hidden rounded-lg border bg-background p-1 shadow-md pointer-fine:block"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="shortcuts-button"
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="?"
            aria-haspopup="dialog"
            onClick={() => onOpenChange(true)}
            className={TOOL_BUTTON_CLASS}
          >
            {/* No <rect> in this glyph: editor tests find the node chrome as the
                first `svg rect` in the container, and a rect-bearing icon ahead
                of the scene would answer for it. */}
            <CircleHelp aria-hidden="true" className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{withShortcut('Keyboard shortcuts', 'show-shortcuts')}</TooltipContent>
      </Tooltip>
      <ShortcutHelpSheet open={open} onOpenChange={onOpenChange} />
    </div>
  )
}

export function ToolPalette({
  leading,
  onCreateNode,
  onCreateLink,
  onCreateGroup,
  onCreateDocumentRef,
  onCreateImage,
  tool,
  onToolChange,
  onZoomToFit,
  onZoomStep,
  shortcutHelp,
  onReturnFocus,
}: ToolPaletteProps) {
  const [addOpen, setAddOpen] = useState(false)
  useReturnFocusWhenClosed(addOpen, onReturnFocus)
  const dockRef = useRef<HTMLDivElement | null>(null)
  const addMenuRef = useRef<HTMLDivElement | null>(null)
  const addButtonRef = useRef<HTMLButtonElement | null>(null)
  // The keyboard-docked formatting bar takes the window's bottom edge while a
  // markdown editor holds the caret; two bars there would overlap. Hidden
  // rather than unmounted so the dock's open menu and refs survive the edit.
  useActiveMarkdownEditor()
  const yieldsToFormattingBar = touchFormattingBarShown()
  const stacked = useStackWhenCramped(dockRef, toolsCramped)

  // Menu convention: opening moves focus to the first entry, so the
  // keyboard path is + → Enter → Enter without a mouse detour.
  useEffect(() => {
    if (!addOpen) return
    addMenuRef.current?.querySelector('button')?.focus()
  }, [addOpen])

  // Close the add menu on any pointerdown outside the dock — the standard
  // menu dismissal path (Escape is handled on the menu itself).
  useEffect(() => {
    if (!addOpen) return
    const onPointerDownAnywhere = (e: PointerEvent) => {
      const dock = dockRef.current
      if (dock !== null && e.target instanceof Node && dock.contains(e.target)) return
      setAddOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDownAnywhere, true)
    return () => window.removeEventListener('pointerdown', onPointerDownAnywhere, true)
  }, [addOpen])

  const entries: readonly AddMenuEntry[] = [
    {
      label: CREATION_LABELS.note,
      icon: <StickyNote aria-hidden="true" className="size-4" />,
      onSelect: onCreateNode,
      drag: 'note',
    },
    {
      label: CREATION_LABELS.link,
      icon: <Link aria-hidden="true" className="size-4" />,
      onSelect: onCreateLink,
    },
    {
      label: CREATION_LABELS.group,
      icon: <Frame aria-hidden="true" className="size-4" />,
      onSelect: onCreateGroup,
      drag: 'group',
    },
    ...(onCreateDocumentRef !== undefined
      ? [
          {
            label: CREATION_LABELS.document,
            icon: <FileBox aria-hidden="true" className="size-4" />,
            onSelect: onCreateDocumentRef,
          },
        ]
      : []),
    ...(onCreateImage !== undefined
      ? [
          {
            label: CREATION_LABELS.image,
            icon: <ImageIcon aria-hidden="true" className="size-4" />,
            onSelect: onCreateImage,
          },
        ]
      : []),
  ]

  return (
    <>
      <div
        ref={dockRef}
        data-editor-overlay
        data-testid="tool-palette"
        role="toolbar"
        aria-label="Canvas tools"
        data-stacked={stacked ? '' : undefined}
        // `w-max` so a stacked dock is laid out against the editor's width:
        // a box centred from `left: 50%` otherwise shrinks to the half right
        // of that line and wraps again.
        className={cn(
          "group absolute bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-1/2 z-10 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-background p-1 shadow-md data-stacked:grid data-stacked:grid-cols-[auto_auto] data-stacked:justify-center data-stacked:gap-y-1 data-stacked:[grid-template-areas:'lead_rest'_'tools_tools']",
          yieldsToFormattingBar && 'hidden',
        )}
      >
        {/* `contents` on one row; on two, each of these wrappers is one cell
          of the dock's grid, and the tools take the whole row beneath — so
          a folded dock is as wide as its widest row, not as the editor. */}
        {leading !== undefined && (
          <div className={cn(STACKED_CELL_CLASS, 'group-data-stacked:[grid-area:lead]')}>
            {leading}
            <div aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
          </div>
        )}
        {/* When the single row cannot hold every tool (a phone), the tools
          take a row of their own along the bottom, nearest the thumb, and the
          history, Add and zoom controls stand above them: a tool scrolled out
          of a strip gives no sign it is there. Scrolling stays only as the
          last resort for an editor too narrow even for the tools' own row.
          The scroller wraps only this group so the "+" menu — which opens
          upward, inside this same container — is not clipped by it. */}
        <div
          data-dock-tools
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto group-data-stacked:justify-self-center group-data-stacked:[grid-area:tools]"
        >
          {DOCK_TOOLS.map((entry) => (
            <DockToolButton
              key={entry.tool}
              entry={entry}
              pressed={tool === entry.tool}
              onToolChange={onToolChange}
            />
          ))}
        </div>
        <div className={cn(STACKED_CELL_CLASS, 'group-data-stacked:[grid-area:rest]')}>
          <div aria-hidden="true" className="mx-0.5 h-5 w-px bg-border group-data-stacked:hidden" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={addButtonRef}
                type="button"
                data-testid="add-button"
                aria-label="Add"
                aria-haspopup="menu"
                aria-expanded={addOpen}
                onClick={() => setAddOpen((open) => !open)}
                className={TOOL_BUTTON_CLASS}
              >
                <Plus aria-hidden="true" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add</TooltipContent>
          </Tooltip>
          <div aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
          <ZoomStepButtons onZoomStep={onZoomStep} />
          <ZoomFitButton onZoomToFit={onZoomToFit} />
        </div>
        {addOpen && (
          <div
            ref={addMenuRef}
            data-testid="add-menu"
            role="menu"
            aria-label="Add"
            // Opens UPWARD from the dock, origin-aware at the bottom edge
            // (never scale(0) — see DESIGN.md Motion). Right-anchored so the
            // menu hugs the "+" end of the dock.
            className="absolute right-0 bottom-[calc(100%+6px)] min-w-40 origin-bottom-right animate-in rounded-md border bg-background py-1 shadow-lg fade-in-0 zoom-in-[0.98] duration-(--motion-duration-normal) ease-(--motion-ease-out)"
            onKeyDown={(e) => {
              const step = menuFocusTarget(
                e.key,
                [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')],
                document.activeElement,
              )
              if (step !== null) {
                e.preventDefault()
                step.focus()
                return
              }
              if (e.key === 'Escape') {
                e.stopPropagation()
                setAddOpen(false)
                // Closing unmounts the focused entry; without an explicit
                // hand-back, focus falls to <body> and the keyboard user
                // loses their place.
                addButtonRef.current?.focus()
              }
            }}
          >
            {entries.map((entry) => (
              <button
                key={entry.label}
                type="button"
                role="menuitem"
                aria-label={entry.label}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent pointer-coarse:min-h-11 focus-visible:bg-accent focus-visible:outline-none"
                // Tapping keeps the viewport-center placement; dragging hands
                // the choice of place to the person making the thing, which is
                // what stops the view jumping to wherever the center happened
                // to be. Both paths stay — a drag is not reachable one-handed
                // on every device, and the keyboard has only the tap.
                draggable={entry.drag !== undefined}
                onDragStart={(e) => {
                  if (entry.drag === undefined) return
                  e.dataTransfer.setData(`${CREATE_DRAG_MIME_PREFIX}${entry.drag}`, entry.drag)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                // Closed on dragEND, not dragstart: removing the source element
                // mid-drag tears down the drag session in Chromium, so closing
                // early makes the drag never reach a drop.
                onDragEnd={() => setAddOpen(false)}
                onClick={() => {
                  setAddOpen(false)
                  entry.onSelect()
                }}
              >
                <span aria-hidden="true" className="text-muted-foreground">
                  {entry.icon}
                </span>
                {entry.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {shortcutHelp !== undefined && <ShortcutsButton {...shortcutHelp} />}
    </>
  )
}

/**
 * The dock's tools, in order. Hand leads: it is the DEFAULT (navigation-first,
 * user decision 2026-08-08), so it sits leftmost where the active mode reads
 * first; the eraser sits beside the pen it takes strokes away from.
 */
const DOCK_TOOLS = [
  { tool: 'hand', label: 'Hand (pan)', tip: 'Hand — drag to pan', Icon: Hand },
  { tool: 'select', label: 'Select', tip: 'Select', Icon: MousePointer2 },
  { tool: 'connect', label: 'Connect', tip: 'Connect nodes', Icon: Spline },
  { tool: 'draw', label: 'Draw', tip: 'Draw — freehand ink', Icon: Pencil },
  { tool: 'erase', label: 'Eraser', tip: 'Eraser — drag over drawings', Icon: Eraser },
] as const satisfies readonly {
  readonly tool: EditorTool
  readonly label: string
  readonly tip: string
  readonly Icon: unknown
}[]

/** The test id a tool's button has always carried: the eraser's is named for the control, not the tool. */
const toolTestId = (tool: (typeof DOCK_TOOLS)[number]['tool']) =>
  `${tool === 'erase' ? 'eraser' : tool}-tool-button`

function DockToolButton({
  entry: { tool, label, tip, Icon },
  pressed,
  onToolChange,
}: {
  readonly entry: (typeof DOCK_TOOLS)[number]
  readonly pressed: boolean
  readonly onToolChange: (tool: EditorTool) => void
}) {
  const shortcut = `tool-${tool}` as const
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={toolTestId(tool)}
          aria-pressed={pressed}
          aria-label={label}
          aria-keyshortcuts={shortcutAriaKeysFor(shortcut)}
          onClick={() => onToolChange(tool)}
          className={TOOL_BUTTON_CLASS}
        >
          <Icon aria-hidden="true" className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{withShortcut(tip, shortcut)}</TooltipContent>
    </Tooltip>
  )
}
