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
 *
 * The same two curves are `--motion-ease-exit` / `--motion-ease-enter` in
 * index.css, for the CSS-driven surfaces (the inspector panel). Stated
 * twice on purpose: this path drives `element.animate()` per patch, and
 * reading a custom property back off the document each time would put a
 * layout read on it.
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

/**
 * Root envelope: attribute maps are compared, not order — DOM attribute order
 * is not semantically meaningful, and setAttribute keeps the existing position
 * on value changes.
 */
function patchRootAttrs(
  root: Element,
  prevAttrs: Readonly<Record<string, string>>,
  nextAttrs: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(nextAttrs)) {
    if (prevAttrs[name] !== value) root.setAttribute(name, value)
  }
  for (const name of Object.keys(prevAttrs)) {
    if (!(name in nextAttrs)) root.removeAttribute(name)
  }
}

/**
 * FLIP first-rects: a REPLACED key (same key, changed bytes) is the one
 * continuity break worth animating — the element is swapped, so the move would
 * otherwise be a hard jump. Insertions deliberately never animate: during a
 * drag the static backdrop excludes the dragged node, so its drop commit
 * arrives as an insertion, and animating that would double-move a node the
 * user just placed.
 *
 * The rect read here is the OLD element's, and the constraint on when it may
 * be read is narrower than it looks: not "before the reconciliation", which
 * only reorders siblings, but BEFORE THE STALE ELEMENT IS REMOVED. An SVG
 * group is placed by its own coordinates rather than by document flow, so
 * `insertBefore` moving it down the child list does not move it on screen.
 *
 * Measured both ways rather than reasoned: moving this call after the
 * reconciliation leaves all six FLIP tests green, and moving it after the
 * cleanup that removes stale elements fails all six. The comment it replaces
 * named the reconciliation, which is the step that happens to come first and
 * not the one that matters.
 */
function captureFirstRects(
  next: KeyedSvgRender,
  elements: ReadonlyMap<string, Element>,
  prevSvgByKey: ReadonlyMap<string, string>,
): Map<string, DOMRect> {
  const firstRects = new Map<string, DOMRect>()
  for (const group of next.groups) {
    const existing = elements.get(group.key)
    if (existing !== undefined && prevSvgByKey.get(group.key) !== group.svg) {
      firstRects.set(group.key, existing.getBoundingClientRect())
    }
  }
  return firstRects
}

/**
 * Which annotation groups ramp in, and which elements ramp out.
 *
 * The annotation layer (canvas-render's `annotation` mark, never this layer's
 * own reading of a key) is the one set whose groups arrive and leave as a
 * unit, so it is the one set worth ramping. Everything else keeps cutting: a
 * document group replaced in place is a keystroke inside a node, and
 * cross-fading those ghosts while somebody types.
 *
 * A REPLACED annotation group is on BOTH lists: the pair of ramps is what
 * makes the `showResolved` case a cross-fade rather than a swap of two nearly
 * identical shapes.
 */
function planRamp(
  prev: KeyedSvgRender,
  next: KeyedSvgRender,
  elements: ReadonlyMap<string, Element>,
  prevSvgByKey: ReadonlyMap<string, string>,
): { arriving: Set<string>; departing: Element[] } {
  const nextKeys = new Set(next.groups.map((group) => group.key))
  const arriving = new Set<string>()
  const departing: Element[] = []
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
  return { arriving, departing }
}

/**
 * Puts `next`'s groups into `root` in order, reusing the element behind a key
 * whose bytes did not change.
 *
 * Anchor by position: insertBefore both inserts new elements and moves reused
 * ones; a replaced key's stale element drifts toward the tail and is dropped
 * by the caller's cleanup.
 */
function reconcileGroups(
  root: Element,
  next: KeyedSvgRender,
  elements: ReadonlyMap<string, Element>,
  prevSvgByKey: ReadonlyMap<string, string>,
): Map<string, Element> {
  const nextElements = new Map<string, Element>()
  next.groups.forEach((group, index) => {
    const existing = elements.get(group.key)
    const element =
      existing !== undefined && prevSvgByKey.get(group.key) === group.svg
        ? existing
        : parseGroup(group.svg)
    nextElements.set(group.key, element)
    const anchor = root.children[index] ?? null
    if (anchor !== element) root.insertBefore(element, anchor)
  })
  return nextElements
}

/**
 * A replaced key that also MOVED belongs to FLIP, not to the ramp: the
 * incoming element is already flying from where its predecessor sat, and a
 * ghost fading at that same spot is the double image FLIP exists to avoid.
 */
function reclaimMovedKeys({
  firstRects,
  nextElements,
  elements,
  arriving,
  leaving,
}: {
  firstRects: ReadonlyMap<string, DOMRect> | undefined
  nextElements: ReadonlyMap<string, Element>
  elements: ReadonlyMap<string, Element>
  arriving: Set<string>
  leaving: Set<Element>
}): void {
  for (const [key, first] of firstRects ?? []) {
    const element = nextElements.get(key)
    if (element === undefined) continue
    const last = element.getBoundingClientRect()
    const moved =
      Math.abs(first.left - last.left) >= MIN_MOVE_PX ||
      Math.abs(first.top - last.top) >= MIN_MOVE_PX
    if (!moved) continue
    arriving.delete(key)
    const stale = elements.get(key)
    if (stale !== undefined) leaving.delete(stale)
  }
}

/** Children past the new group count: faded out when they were planned to leave, else removed. */
function dropSurplusChildren(
  root: Element,
  keep: number,
  leaving: ReadonlySet<Element>,
  fadeOut: (child: Element) => void,
): void {
  for (const child of [...root.children].slice(keep)) {
    if (leaving.has(child)) fadeOut(child)
    else child.remove()
  }
}

function fadeInArriving(
  arriving: ReadonlySet<string>,
  nextElements: ReadonlyMap<string, Element>,
): void {
  for (const key of arriving) {
    const element = nextElements.get(key)
    if (element === undefined || typeof element.animate !== 'function') continue
    element.animate([{ opacity: 0 }, { opacity: 1 }], FADE_IN)
  }
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
    patchRootAttrs(root, prev.rootAttrs, next.rootAttrs)

    const prevSvgByKey = new Map(prev.groups.map((group) => [group.key, group.svg]))
    const animate =
      options?.motion !== false && updateOptions?.animate !== false && !prefersReducedMotion()
    // Before the cleanup below removes the stale elements these rects are
    // read from — see captureFirstRects for why that, and not the
    // reconciliation, is the boundary.
    const firstRects = animate ? captureFirstRects(next, elements, prevSvgByKey) : undefined
    const { arriving, departing } = animate
      ? planRamp(prev, next, elements, prevSvgByKey)
      : { arriving: new Set<string>(), departing: [] as Element[] }
    const leaving = new Set(departing)

    const nextElements = reconcileGroups(root, next, elements, prevSvgByKey)

    reclaimMovedKeys({ firstRects, nextElements, elements, arriving, leaving })

    dropSurplusChildren(root, next.groups.length, leaving, fadeOut)
    fadeInArriving(arriving, nextElements)

    if (firstRects !== undefined && firstRects.size > 0) {
      playMoveAnimations(root, nextElements, firstRects)
    }

    elements.clear()
    for (const [key, element] of nextElements) elements.set(key, element)
    prev = next
  }

  return { root, update }
}
