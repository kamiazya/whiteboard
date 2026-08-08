/**
 * Right-click menu — the OOUI object-action surface.
 *
 * Per the recorded decision (palette owns creation; objects own their
 * actions): a node's full action set lives here, reached from the object
 * itself. Empty canvas space gets its own creation entry, since "here" is
 * position information the bottom palette cannot express.
 *
 * Two item shapes:
 * - action items run once and CLOSE the menu (Edit, Delete);
 * - option rows (`kind: 'options'`) are property pickers rendered as an
 *   inline segmented group — selecting one applies immediately and KEEPS
 *   the menu open, so adjusting several properties (arrows, both edge
 *   sides) is one menu visit instead of an open-tap-reopen cycle per step.
 *
 * Marked `data-editor-overlay` so the canvas root's gesture handlers ignore
 * presses inside the menu. Item actions fire on CLICK (not pointerdown) for
 * the same reason as the selection Edit control: an editor opened inside a
 * discrete pointerdown loses the focus fight with mousedown's default
 * action, while click fires after those defaults.
 */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** Gap kept between the menu and the editor edge when nudging it inside. */
const MENU_EDGE_MARGIN_PX = 4

export interface ContextMenuActionItem {
  readonly kind?: 'action'
  readonly label: string
  /** Leading icon (a lucide element); decorative — the label carries the name. */
  readonly icon?: ReactNode
  readonly onSelect: () => void
  /** Visually separates destructive entries (Delete). */
  readonly danger?: boolean
}

export interface ContextMenuOption {
  /** Visible content of the option button (often a glyph). */
  readonly label: string
  /** Icon rendered INSTEAD of the label text when provided (decorative). */
  readonly icon?: ReactNode
  /** Accessible name when the visible label is a glyph; defaults to label. */
  readonly ariaLabel?: string
  readonly selected: boolean
  readonly onSelect: () => void
}

export interface ContextMenuOptionsItem {
  readonly kind: 'options'
  readonly label: string
  readonly options: readonly ContextMenuOption[]
}

/** Visual section boundary between action, property, and destructive groups. */
export interface ContextMenuSeparator {
  readonly kind: 'separator'
}

export type ContextMenuItem = ContextMenuActionItem | ContextMenuOptionsItem | ContextMenuSeparator

export interface ContextMenuProps {
  /** Screen position relative to the editor root. */
  readonly x: number
  readonly y: number
  readonly items: readonly ContextMenuItem[]
  readonly onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  // A menu opened near the editor's right/bottom edge would clip outside it,
  // so the requested position is nudged back inside once the real menu size
  // is measurable. useLayoutEffect corrects before paint — no visible jump.
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = menuRef.current
    const parent = el?.offsetParent
    if (el == null || !(parent instanceof HTMLElement)) {
      setPos((prev) => (prev.x === x && prev.y === y ? prev : { x, y }))
      return
    }
    const clamp = (value: number, max: number) =>
      Math.max(MENU_EDGE_MARGIN_PX, Math.min(value, max))
    // Ceil the measured box: offsetWidth/Height round to integers, so a
    // fractional menu width would overshoot the margin by a subpixel.
    const menuRect = el.getBoundingClientRect()
    const next = {
      x: clamp(x, parent.clientWidth - Math.ceil(menuRect.width) - MENU_EDGE_MARGIN_PX),
      y: clamp(y, parent.clientHeight - Math.ceil(menuRect.height) - MENU_EDGE_MARGIN_PX),
    }
    setPos((prev) => (prev.x === next.x && prev.y === next.y ? prev : next))
  }, [x, y])

  // Focus the menu on open so Escape works without an extra click, and close
  // on any pointerdown outside — both standard menu dismissal paths.
  useEffect(() => {
    menuRef.current?.focus()
    const onPointerDownAnywhere = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-context-menu]') !== null) return
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDownAnywhere, true)
    return () => window.removeEventListener('pointerdown', onPointerDownAnywhere, true)
  }, [onClose])

  return (
    <div
      ref={menuRef}
      data-editor-overlay
      data-context-menu
      data-testid="context-menu"
      role="menu"
      aria-label="Canvas actions"
      tabIndex={-1}
      className="min-w-36 rounded-md border bg-background py-1 shadow-lg focus:outline-none"
      // Positioning (incl. stacking) is inline, not utility classes: the
      // edge-clamping above measures the absolutely-positioned box, and it
      // must behave the same where the app stylesheet is absent
      // (browser-mode component tests).
      // width: max-content keeps the measured size intrinsic — an absolute
      // box otherwise shrinks to fit the space left of the containing-block
      // edge, so a menu opened near the edge would measure (and wrap) narrow
      // and the clamp would compute from the wrong width.
      style={{ position: 'absolute', zIndex: 20, width: 'max-content', left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      {items.map((item, index) =>
        item.kind === 'separator' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: separators are positional by nature and the items list is rebuilt per open
          <hr key={`separator-${index}`} className="my-1 border-border" />
        ) : item.kind === 'options' ? (
          <fieldset
            key={item.label}
            aria-label={item.label}
            className="m-0 flex items-center justify-between gap-2 border-0 p-0 px-3 py-1"
          >
            <span className="text-xs text-muted-foreground">{item.label}</span>
            <span className="flex items-center gap-0.5">
              {item.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.selected}
                  aria-label={option.ariaLabel ?? option.label}
                  className={cn(
                    'flex h-7 min-w-7 items-center justify-center rounded px-1 text-xs transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out) hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                    option.selected
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground',
                  )}
                  // Applies immediately and keeps the menu open: option rows
                  // are property pickers, and closing per pick would force a
                  // reopen for every adjustment.
                  onClick={option.onSelect}
                >
                  {option.icon !== undefined ? (
                    <span aria-hidden="true" className="[&>svg]:size-3.5">
                      {option.icon}
                    </span>
                  ) : (
                    option.label
                  )}
                </button>
              ))}
            </span>
          </fieldset>
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none ${
              item.danger ? 'text-red-600' : ''
            }`}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.icon !== undefined && (
              // Danger rows keep the destructive color on the icon too.
              <span
                aria-hidden="true"
                className={cn('[&>svg]:size-3.5', !item.danger && 'text-muted-foreground')}
              >
                {item.icon}
              </span>
            )}
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}
