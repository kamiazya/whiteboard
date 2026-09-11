/**
 * A trigger and the floating panel it opens.
 *
 * A catalog is hundreds of cells with a search box over them, and a row in
 * a property panel is one line tall. Inline, `visual.symbol` took more
 * vertical space than every other facet put together and pushed the rows
 * under it off the panel — so the row shows what is CHOSEN and the choosing
 * happens in a panel over the top.
 *
 * Two things follow, and both are why this is a component rather than a
 * `<details>`:
 *
 * - **The panel must escape its scroll container.** The inspector scrolls;
 *   an absolutely-positioned child of it is clipped at the first edge. The
 *   native Popover API puts the panel in the TOP LAYER, which nothing
 *   clips, and hands over light dismiss and Escape with it.
 * - **Its content must not mount until it is opened.** The whole point of a
 *   catalog's `load()` being a promise is that a dynamic import is a
 *   separate chunk; a panel that mounts its content eagerly fetches that
 *   chunk for every row on screen.
 *
 * The non-native path is not dead code and not a legacy fallback: jsdom
 * implements none of the Popover API — measured, `showPopover` is
 * `undefined` and `popover` is not even a property — so it is the path the
 * jsdom suite runs, and the browser suite runs the other one. Both are
 * covered.
 */
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from 'react'

const INK = 'var(--foreground, #171717)'
const MUTED = 'var(--muted-foreground, #737373)'
const LINE = 'var(--border, #e5e5e5)'
const SURFACE = 'var(--popover, var(--background, #ffffff))'
const RING = 'var(--ring, #3b82f6)'

/**
 * Feature-detected ONCE, at module scope, because the answer decides how
 * the trigger is wired and that has to be decided before the first render:
 * with the API present the BROWSER owns opening and closing (the trigger is
 * `popovertarget`, so light dismiss knows the trigger is part of the
 * popover and a press on it does not close-then-reopen), and without it
 * this component does.
 */
const NATIVE_POPOVER =
  typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function'

/** The width a catalog wants, clamped to a phone at the placement step. */
const PANEL_WIDTH = 320

const TRIGGER: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  height: '1.75rem',
  minWidth: '1.75rem',
  padding: '0 0.375rem',
  borderRadius: '0.25rem',
  border: `1px solid ${LINE}`,
  background: 'transparent',
  color: INK,
  fontSize: '0.9rem',
  lineHeight: 1,
  cursor: 'pointer',
}

const CHEVRON: CSSProperties = { color: MUTED, fontSize: '0.6rem' }

const PANEL: CSSProperties = {
  position: 'fixed',
  margin: 0,
  padding: '0.5rem',
  border: `1px solid ${LINE}`,
  borderRadius: '0.5rem',
  background: SURFACE,
  color: INK,
  boxShadow: '0 8px 24px rgb(0 0 0 / 0.12)',
  // Above the inspector on the non-native path, where there is no top layer
  // to be in. Ignored when the browser has put it in one.
  zIndex: 50,
}

export interface CatalogPopoverProps {
  /** What the panel is called, for a reader with no heading in view. */
  readonly label: string
  /** Drawn in the trigger: the current value's picture, or its word. */
  readonly current: ReactNode
  /** Mounted only while open — see the note on `load()` above. */
  readonly children: ReactNode
}

export function CatalogPopover({ label, current, children }: CatalogPopoverProps) {
  const id = useId().replace(/:/g, '-')
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = panel.current
    const button = anchor.current
    if (el === null || button === null) return

    // The BROWSER is the source of truth when it owns the popover: a light
    // dismiss is a close this component never asked for, and reading it
    // back is what keeps the content from staying mounted behind a panel
    // nobody can see.
    const onToggle = (event: Event) => {
      const state = (event as Event & { newState?: string }).newState
      setOpen(state === 'open')
    }
    if (NATIVE_POPOVER) el.addEventListener('toggle', onToggle)

    if (!open) {
      return () => {
        if (NATIVE_POPOVER) el.removeEventListener('toggle', onToggle)
      }
    }

    const place = () => {
      const rect = button.getBoundingClientRect()
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 16)
      // Right-aligned to the trigger, which is where the trigger itself
      // sits in a property row — then clamped, so a row near either edge
      // opens a panel that is entirely on screen.
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
      el.style.left = `${left}px`
      el.style.top = `${rect.bottom + 6}px`
      el.style.width = `${width}px`
    }
    place()

    const dismiss = (event: Event) => {
      const target = event.target as Node | null
      if (target !== null && (el.contains(target) || button.contains(target))) return
      setOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    // Only where the browser does not already do both.
    if (!NATIVE_POPOVER) {
      document.addEventListener('pointerdown', dismiss, true)
      document.addEventListener('keydown', onEscape)
    }
    window.addEventListener('resize', place)
    // Capturing, so the panel follows a trigger inside a scrolling panel
    // rather than staying where the page was when it opened.
    window.addEventListener('scroll', place, true)
    return () => {
      if (NATIVE_POPOVER) el.removeEventListener('toggle', onToggle)
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', onEscape)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        style={TRIGGER}
        // With the native API the browser toggles, and the link is what
        // tells light dismiss that this button belongs to the panel.
        {...(NATIVE_POPOVER ? { popoverTarget: id } : { onClick: () => setOpen((was) => !was) })}
        onFocus={(event) => {
          event.currentTarget.style.outline = `2px solid ${RING}`
          event.currentTarget.style.outlineOffset = '1px'
        }}
        onBlur={(event) => {
          event.currentTarget.style.outline = 'none'
        }}
      >
        {current}
        <span aria-hidden="true" style={CHEVRON}>
          ▾
        </span>
      </button>
      {/* The element is always present so `popovertarget` has something to
          find; only its CONTENT waits for the panel to be opened. */}
      <div
        ref={panel}
        id={id}
        role="dialog"
        aria-label={label}
        {...(NATIVE_POPOVER ? { popover: 'auto' } : { hidden: !open })}
        style={PANEL}
      >
        {open && children}
      </div>
    </>
  )
}
