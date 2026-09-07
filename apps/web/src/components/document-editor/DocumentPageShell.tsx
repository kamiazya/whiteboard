import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type InspectorPresence,
  InspectorPresenceContext,
} from '../../contexts/inspector-presence.js'

/**
 * The two-row grid shell both document pages stand in.
 *
 * Everything header-shaped stacks inside the `auto` row, and the editor owns
 * `minmax(0,1fr)` — however many banner rows appear (or however tall they
 * wrap), the editor row is always exactly the remaining viewport height,
 * never clipped below it. Both pages carried this template and the sr-only
 * `<h1>` landmark by hand; owning them here means a layout or a11y drift
 * between the two modes cannot happen quietly.
 *
 * `aside` is the document's inspector — its history column or its comments
 * rail, whichever the page's one inspector slot holds. It rides in the editor
 * row rather than beside the whole page, so the top bar keeps the full width
 * and the aside is exactly as tall as the editor it belongs to. The row is
 * wrapped whether or not there is an aside: wrapping it only when one arrived
 * re-parented the editor, and React remounts what changes parent — so opening
 * the history column threw away the editor's own state (its viewport, its
 * selection) for a layout that had not changed. The wrapper is `relative`
 * because the aside is a column only where there is width for one: under
 * 768px it is a bottom sheet, positioned against this row so it covers the
 * editor and not the top bar above it.
 *
 * It also owns the inspector's PRESENCE. React drops the pane the instant
 * the page releases the slot, so a leaving animation would have nothing to
 * run on; this keeps the outgoing pane rendered until it says it has
 * finished (`contexts/inspector-presence.ts`). Only when the slot goes
 * EMPTY — a SWAP between two panes is not an exit, and drawing the old one
 * over the new for a beat would read as two inspectors open at once, which
 * is the thing the single slot exists to prevent.
 *
 * Nothing here goes fullscreen: the shell fullscreens the whole document
 * (`hooks/use-fullscreen.ts`), so this element needs no ref to be promoted
 * through and no ground of its own — a `<main>` promoted to the top layer
 * alone used to composite over black, and carried `bg-background` for it.
 */
export function DocumentPageShell({
  srTitle,
  header,
  children,
  aside,
}: {
  /** The page's visually-hidden `<h1>` landmark text. */
  srTitle: string
  /** The header row's contents, after the landmark. */
  header: ReactNode
  /** The editor row, and any banner rows the page stacks above it. */
  children: ReactNode
  /** The document's inspector, beside the editor row (a sheet over it when narrow). */
  aside?: ReactNode
}) {
  const [leaving, setLeaving] = useState<ReactNode>(null)
  const lastAside = useRef<ReactNode>(null)
  useEffect(() => {
    if (aside !== undefined) {
      lastAside.current = aside
      // A swap replaces the outgoing pane outright: whatever was leaving is
      // gone, and the arriving pane plays its own entrance.
      setLeaving(null)
      return
    }
    if (lastAside.current === null) return
    setLeaving(lastAside.current)
    lastAside.current = null
  }, [aside])

  // Whether the slot held a pane on the PREVIOUS render. Updated in an
  // effect, so during the render that mounts a new pane it still holds the
  // answer for the moment before — which is exactly the question that pane
  // asks itself once, on mount.
  const wasOccupied = useRef(false)
  useEffect(() => {
    wasOccupied.current = aside !== undefined
  })

  const closing = useMemo<InspectorPresence>(
    () => ({ state: 'closed', slotWasOccupied: false, onLeft: () => setLeaving(null) }),
    [],
  )
  const live = useMemo<InspectorPresence>(
    () => ({ state: 'open', slotWasOccupied: wasOccupied.current, onLeft: () => {} }),
    // Rebuilt per `aside` rather than on the ref, which is not a dependency
    // React can track — and the pane below captures the value once on mount
    // anyway, so a later object with a staler flag reaches nobody.
    [aside],
  )
  // A pane that never animates would otherwise stay on screen forever,
  // covering the editor. The frame is the fallback, not the mechanism:
  // whichever arrives first wins, and under prefers-reduced-motion the
  // 0.01ms animation ends on that same frame.
  const drop = useCallback(() => setLeaving(null), [])
  useEffect(() => {
    if (leaving === null) return
    const timer = setTimeout(drop, LEAVING_CEILING_MS)
    return () => clearTimeout(timer)
  }, [leaving, drop])

  return (
    <main className="relative grid h-full w-full grid-rows-[auto_minmax(0,1fr)]">
      <div className="min-w-0">
        <h1 className="sr-only">{srTitle}</h1>
        {header}
      </div>
      <div className="relative flex min-h-0 min-w-0">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        {aside === undefined ? (
          leaving === null ? null : (
            <InspectorPresenceContext.Provider value={closing}>
              {leaving}
            </InspectorPresenceContext.Provider>
          )
        ) : (
          <InspectorPresenceContext.Provider value={live}>
            {aside}
          </InspectorPresenceContext.Provider>
        )}
      </div>
    </main>
  )
}

/**
 * How long a leaving pane may stay before it is dropped regardless.
 *
 * A CEILING on a failure, not the exit's duration — the exit ends on its own
 * `animationend`. It is generous on purpose: too tight and it would cut a
 * real animation short, which is the one thing this must not do.
 */
const LEAVING_CEILING_MS = 1000
