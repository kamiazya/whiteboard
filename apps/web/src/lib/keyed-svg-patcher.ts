/**
 * Mount-once, patch-forever consumer of canvas-render's keyed SVG
 * projection. The first render lands as one innerHTML write; every later
 * render is a keyed reconciliation that touches only the groups whose
 * serialized bytes changed — string equality IS change detection, because
 * the producer's serializer is canonical and deterministic.
 *
 * Every byte that reaches the DOM is serializer-produced (the group
 * strings themselves): this layer decides only WHICH elements to replace,
 * never how markup is spelled, so canvas-render stays the single producer
 * the `dangerouslySetInnerHTML` safety argument rests on. What patching
 * buys over innerHTML replacement is DOM continuity for the 94-99% of
 * groups a typical edit leaves byte-identical (the scene-diff scoreboard's
 * measured reuse ceiling): selection, focus, running CSS animations and
 * decoded images on untouched groups survive an update.
 */

import type { KeyedSvgRender } from '@kamiazya/whiteboard-canvas-render'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface KeyedSvgUpdateOptions {
  /**
   * `false` says this update is NOT a change to the document — the host
   * swapped which pipeline produces the render, and the same content is
   * arriving through a different door.
   *
   * It exists because the editor patches this one container to the drag
   * BACKDROP for the length of a gesture, and that backdrop excludes
   * whatever the drag layer draws live. Grabbing a comment pin therefore
   * reaches this layer as a removal and dropping it as an insertion, so
   * without this the pin would fade out under the preview that is carrying
   * it and fade back in where it landed.
   */
  readonly animate?: boolean
}

export interface KeyedSvgPatcher {
  /** The mounted `<svg>` root — stable for the patcher's whole lifetime. */
  readonly root: SVGSVGElement
  update(next: KeyedSvgRender, options?: KeyedSvgUpdateOptions): void
}

export interface KeyedSvgPatcherOptions {
  /** `false` disables the FLIP move animation (default on, and always off
   * under `prefers-reduced-motion`). */
  readonly motion?: boolean
}

const MOVE_ANIMATION: KeyframeAnimationOptions = {
  duration: 180,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
}
/** Screen-px deltas below this are layout noise, not a move. */
const MIN_MOVE_PX = 0.5

/**
 * The ANNOTATION layer's arrive/leave ramp, at the rail's
 * `--motion-duration-normal` so one resolve reads as one gesture wherever
 * the reader is watching it.
 *
 * Opacity only: a compositor property, and the one DESIGN.md names as the
 * exception where the value IS the state.
 *
 * The EASING is not `--motion-ease-out`, and that is measured rather than
 * chosen. That token is `cubic-bezier(0.16, 1, 0.3, 1)`, which is shaped
 * for a MOVE — nearly all of its travel is spent in the first fifth so the
 * object settles gently. Applied to opacity it hides the event: captured in
 * a real browser, the pin was 65% faded 40ms in and invisible by 110ms, so
 * a declared 220ms ramp spent its remaining half on the last hundredth of
 * a percent nobody can see. Opacity's perceived moment is the middle, so
 * these are the standard accelerate/decelerate pair instead.
 */
const FADE_DURATION_MS = 220
/** Leaving accelerates: it lingers long enough to be read, then goes. */
const FADE_OUT: KeyframeAnimationOptions = {
  duration: FADE_DURATION_MS,
  easing: 'cubic-bezier(0.4, 0, 1, 1)',
}
/** Arriving decelerates, the mirror of it. */
const FADE_IN: KeyframeAnimationOptions = {
  duration: FADE_DURATION_MS,
  easing: 'cubic-bezier(0, 0, 0.2, 1)',
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

/**
 * Plays the FLIP "invert + play" half: each replaced element starts at a
 * transform that puts it back where its predecessor sat, and animates to
 * none. Deltas are measured in screen px and converted to the root's USER
 * units, because a CSS translate on an SVG child applies in local
 * coordinates while the editor scales the whole surface for zoom — a
 * screen-px delta applied directly would overshoot by the zoom factor.
 * WAAPI leaves no inline style behind, so the converged DOM stays byte-
 * equal to a fresh mount.
 */
function playMoveAnimations(
  root: SVGSVGElement,
  elements: ReadonlyMap<string, Element>,
  firstRects: ReadonlyMap<string, DOMRect>,
): void {
  const rootRect = root.getBoundingClientRect()
  if (rootRect.width <= 0 || rootRect.height <= 0) return
  const viewBox = root.viewBox.baseVal
  const scaleX = viewBox !== null && viewBox.width > 0 ? rootRect.width / viewBox.width : 1
  const scaleY = viewBox !== null && viewBox.height > 0 ? rootRect.height / viewBox.height : 1
  for (const [key, first] of firstRects) {
    const element = elements.get(key)
    if (element === undefined || typeof element.animate !== 'function') continue
    const last = element.getBoundingClientRect()
    const dxPx = first.left - last.left
    const dyPx = first.top - last.top
    if (Math.abs(dxPx) < MIN_MOVE_PX && Math.abs(dyPx) < MIN_MOVE_PX) continue
    const dx = dxPx / scaleX
    const dy = dyPx / scaleY
    element.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      MOVE_ANIMATION,
    )
  }
}

/** Parses one group's serialized bytes into its single element. */
function parseGroup(svg: string): Element {
  const host = document.createElementNS(SVG_NS, 'svg')
  host.innerHTML = svg
  const element = host.firstElementChild
  if (element === null) {
    // A group is one element by the producer's contract; an empty parse
    // means the contract broke upstream, which must not fail silently.
    throw new Error('keyed svg group parsed to no element')
  }
  return element
}

export function mountKeyedSvg(
  container: Element,
  initial: KeyedSvgRender,
  options?: KeyedSvgPatcherOptions,
): KeyedSvgPatcher {
  container.innerHTML = initial.svg
  const root = container.firstElementChild
  if (!(root instanceof SVGSVGElement)) {
    throw new Error('keyed svg document parsed to no <svg> root')
  }

  // The mounted document's children correspond 1:1, in order, to
  // `groups` — the producer pins `svg === rootOpen + groups + close`.
  let prev = initial
  const elements = new Map<string, Element>()
  /**
   * Fades a departing annotation element out and drops it when the ramp
   * ends. It needs no bookkeeping of its own: the reconciliation moves
   * every surviving group ahead of it, so a ghost is always past the group
   * count and the cleanup below takes it if another update lands first —
   * the mounted DOM converges to exactly the groups either way. A version
   * that also tracked ghosts and swept them at the top of `update` was
   * written, and its guard could not be made to fail.
   */
  const fadeOut = (element: Element): void => {
    if (typeof element.animate !== 'function') {
      element.remove()
      return
    }
    const animation = element.animate([{ opacity: 1 }, { opacity: 0 }], FADE_OUT)
    // A rejection means a later update already removed it, which is the
    // outcome this wanted — not an error to surface.
    animation.finished.then(
      () => element.remove(),
      () => {},
    )
  }

  initial.groups.forEach((group, index) => {
    const child = root.children[index]
    if (child !== undefined) elements.set(group.key, child)
  })

  const update = (next: KeyedSvgRender, updateOptions?: KeyedSvgUpdateOptions): void => {
    // Root envelope: attribute maps are compared, not order — DOM
    // attribute order is not semantically meaningful, and setAttribute
    // keeps the existing position on value changes.
    for (const [name, value] of Object.entries(next.rootAttrs)) {
      if (prev.rootAttrs[name] !== value) root.setAttribute(name, value)
    }
    for (const name of Object.keys(prev.rootAttrs)) {
      if (!(name in next.rootAttrs)) root.removeAttribute(name)
    }

    const prevSvgByKey = new Map(prev.groups.map((group) => [group.key, group.svg]))
    const nextElements = new Map<string, Element>()
    // FLIP first-rects: a REPLACED key (same key, changed bytes) is the one
    // continuity break worth animating — the element is swapped, so the
    // move would otherwise be a hard jump. Insertions deliberately never
    // animate: during a drag the static backdrop excludes the dragged
    // node, so its drop commit arrives as an insertion, and animating that
    // would double-move a node the user just placed. Rects are captured
    // BEFORE the reconciliation loop displaces anything.
    const animate =
      options?.motion !== false && updateOptions?.animate !== false && !prefersReducedMotion()
    const firstRects = animate ? new Map<string, DOMRect>() : undefined
    if (firstRects !== undefined) {
      for (const group of next.groups) {
        const existing = elements.get(group.key)
        if (existing !== undefined && prevSvgByKey.get(group.key) !== group.svg) {
          firstRects.set(group.key, existing.getBoundingClientRect())
        }
      }
    }
    // The annotation layer (canvas-render's `annotation` mark, never this
    // layer's own reading of a key) is the one set whose groups arrive and
    // leave as a unit, so it is the one set worth ramping. Everything else
    // keeps cutting: a document group replaced in place is a keystroke
    // inside a node, and cross-fading those ghosts while somebody types.
    const nextKeys = new Set(next.groups.map((group) => group.key))
    // A REPLACED annotation group is on both lists: the pair of ramps is
    // what makes the `showResolved` case a cross-fade rather than a swap of
    // two nearly identical shapes.
    const arriving = new Set<string>()
    const departing: Element[] = []
    if (animate) {
      for (const group of next.groups) {
        if (group.annotation !== true) continue
        const existing = elements.get(group.key)
        if (existing === undefined) {
          arriving.add(group.key)
        } else if (prevSvgByKey.get(group.key) !== group.svg) {
          arriving.add(group.key)
          departing.push(existing)
        }
      }
      for (const group of prev.groups) {
        if (group.annotation !== true || nextKeys.has(group.key)) continue
        const gone = elements.get(group.key)
        if (gone !== undefined) departing.push(gone)
      }
    }
    const leaving = new Set(departing)

    next.groups.forEach((group, index) => {
      const existing = elements.get(group.key)
      const element =
        existing !== undefined && prevSvgByKey.get(group.key) === group.svg
          ? existing
          : parseGroup(group.svg)
      nextElements.set(group.key, element)
      // Anchor by position: insertBefore both inserts new elements and
      // moves reused ones; a replaced key's stale element drifts toward
      // the tail and is dropped by the cleanup below.
      const anchor = root.children[index] ?? null
      if (anchor !== element) root.insertBefore(element, anchor)
    })

    // A replaced key that also MOVED belongs to FLIP, not to the ramp: the
    // incoming element is already flying from where its predecessor sat, and
    // a ghost fading at that same spot is the double image FLIP exists to
    // avoid.
    for (const [key, first] of firstRects ?? []) {
      const element = nextElements.get(key)
      if (element === undefined) continue
      const last = element.getBoundingClientRect()
      if (
        Math.abs(first.left - last.left) < MIN_MOVE_PX &&
        Math.abs(first.top - last.top) < MIN_MOVE_PX
      ) {
        continue
      }
      arriving.delete(key)
      const stale = elements.get(key)
      if (stale !== undefined) leaving.delete(stale)
    }

    for (const child of [...root.children].slice(next.groups.length)) {
      if (leaving.has(child)) fadeOut(child)
      else child.remove()
    }

    for (const key of arriving) {
      const element = nextElements.get(key)
      if (element === undefined || typeof element.animate !== 'function') continue
      element.animate([{ opacity: 0 }, { opacity: 1 }], FADE_IN)
    }

    if (firstRects !== undefined && firstRects.size > 0) {
      playMoveAnimations(root, nextElements, firstRects)
    }

    elements.clear()
    for (const [key, element] of nextElements) elements.set(key, element)
    prev = next
  }

  return { root, update }
}
