/**
 * Right-click menu — the OOUI object-action surface.
 *
 * Per the recorded decision (palette owns creation; objects own their
 * actions): a node's full action set lives here, reached from the object
 * itself. Empty canvas space gets its own creation entry, since "here" is
 * position information the bottom palette cannot express.
 *
 * Marked `data-editor-overlay` so the canvas root's gesture handlers ignore
 * presses inside the menu. Item actions fire on CLICK (not pointerdown) for
 * the same reason as the selection Edit control: an editor opened inside a
 * discrete pointerdown loses the focus fight with mousedown's default
 * action, while click fires after those defaults.
 */
import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  readonly label: string
  readonly onSelect: () => void
  /** Visually separates destructive entries (Delete). */
  readonly danger?: boolean
}

export interface ContextMenuProps {
  /** Screen position relative to the editor root. */
  readonly x: number
  readonly y: number
  readonly items: readonly ContextMenuItem[]
  readonly onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)

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
      className="absolute z-20 min-w-36 rounded-md border bg-background py-1 shadow-lg focus:outline-none"
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none ${
            item.danger ? 'text-red-600' : ''
          }`}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
