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
/** Between the trigger and the panel, and between the panel and the edge. */
const GAP = 6
const EDGE = 8
/**
 * Below this a downward panel is not worth opening — the search box and one
 * row of cells are about 240px, so less than that shows a scroller with
 * nothing usable above it and the panel flips to the other side instead.
 */
const MIN_HEIGHT = 240

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
  // The panel is taller than a laptop in a browser window: `maxHeight` is
  // set per placement and this is what makes it scroll rather than clip.
  // The UA sheet gives a native popover `overflow: auto` already; the
  // fallback path is a plain div and gets nothing.
  overflowY: 'auto',
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
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * EDGE)
      // Right-aligned to the trigger, which is where the trigger itself
      // sits in a property row — then clamped, so a row near either edge
      // opens a panel that is entirely on screen.
      const left = Math.max(EDGE, Math.min(rect.right - width, window.innerWidth - width - EDGE))
      el.style.left = `${left}px`
      el.style.width = `${width}px`

      // The VERTICAL half of the same rule, and it needs both a side and a
      // ceiling. `position: fixed` clips nothing and grows nothing: a
      // catalog opened from a row near the bottom of the inspector — which
      // is where the last facet in the panel always is — put its search box
      // and every cell below the fold, on the native path as much as the
      // fallback, because the top layer is not a scroll container either.
      const below = window.innerHeight - rect.bottom - GAP - EDGE
      const above = rect.top - GAP - EDGE
      // Flip only when it actually buys room. A trigger low on a tall page
      // has little either way, and a panel that jumps sides for two pixels
      // reads as a glitch.
      //
      // Against the panel's OWN natural height where the browser reports
      // one, because this component does not know what a catalog is tall:
      // `scrollHeight` is the content, so it stays the same number once
      // `maxHeight` is applied and a re-placement cannot walk it downwards.
      // jsdom reports 0 and the floor answers instead.
      const wanted = Math.max(MIN_HEIGHT, el.scrollHeight)
      const up = below < wanted && above > below
      // Never taller than the viewport, and never a sliver: on a short
      // screen a scrolling panel beats a correctly-sized useless one.
      const room = Math.min(window.innerHeight - 2 * EDGE, Math.max(MIN_HEIGHT, up ? above : below))
      el.style.maxHeight = `${room}px`
      // Both are written every time, and `auto` rather than `''` on
      // purpose: the UA stylesheet gives `[popover]` `inset: 0`, so
      // clearing `top` does not leave it unset — it leaves it at 0, and the
      // over-constrained rule then drops the `bottom` that was supposed to
      // anchor the panel above the trigger.
      el.style.top = up ? 'auto' : `${rect.bottom + GAP}px`
      el.style.bottom = up ? `${window.innerHeight - rect.top + GAP}px` : 'auto'
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
    // A catalog opens at its loading height and grows when `load()` lands,
    // so the side chosen at open was chosen against the wrong height. jsdom
    // has no ResizeObserver, and the placement is correct without it — this
    // only re-asks a question already answered once.
    const grew =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => place())
    grew?.observe(el)
    return () => {
      grew?.disconnect()
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
