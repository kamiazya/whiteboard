import { type RefObject, useLayoutEffect, useState } from 'react'

/** Gap kept between the menu and the editor edge when nudging it inside. */
const MENU_EDGE_MARGIN_PX = 4

/**
 * Where a point-anchored menu should sit. A menu opened near the editor's
 * right/bottom edge would clip outside it, so it is nudged back inside once
 * measurable, before paint (no visible jump). An edge-anchored sheet has
 * nothing to clamp.
 */
export function useEdgeClampedPosition(
  menuRef: RefObject<HTMLElement | null>,
  x: number,
  y: number,
  edgeAnchored: boolean,
): { readonly x: number; readonly y: number } {
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    if (edgeAnchored) return
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
  }, [menuRef, x, y, edgeAnchored])
  return pos
}
