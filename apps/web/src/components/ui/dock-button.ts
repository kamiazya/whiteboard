/**
 * Sizing tokens for the bottom dock's controls.
 *
 * The dock renders as one row but is assembled from two files that cannot
 * import each other's intent: ToolPalette owns the tool buttons, and the
 * `leading` slot is filled by whatever the host passes (today HistoryCluster,
 * or the editor's own zoom controls in hand mode). Each having its own size
 * literal is what let a `pointer-coarse` step land on one side only, putting a
 * 44px control next to a 36px one in the same row.
 *
 * Height is separated from width because one control is legitimately not
 * square: the zoom readout shows "100%" and must be wider than it is tall.
 * Composing `DOCK_BUTTON_CLASS` for the square case and
 * `DOCK_BUTTON_HEIGHT_CLASS` + an explicit width for the wide one keeps every
 * control the same height without a width conflict — the previous code stacked
 * `w-12` on top of `size-9`, leaving two competing width declarations whose
 * winner depended on stylesheet order rather than on anything a reader could
 * see.
 *
 * 44px on coarse pointers is the touch-target floor; 36px is comfortable for a
 * mouse and keeps the dock narrow enough to stay one row on a phone.
 */
export const DOCK_BUTTON_HEIGHT_CLASS = 'h-9 pointer-coarse:h-11'

/**
 * The same two sizes in pixels, for code that must reason about the dock's
 * footprint without being able to observe it.
 *
 * A layout test cannot render under `pointer: coarse` — the runner exposes no
 * way to emulate the media feature — yet the coarse dock is the wide one, and
 * therefore the one that collides. Deriving the numbers from the class string
 * lets such a test compute the worst-case footprint from the fine-pointer
 * render it CAN produce, without a second copy of the sizes to keep in sync.
 *
 * Tailwind's spacing scale is 4px per step, so `h-9` is 36px and `h-11` is
 * 44px; `dockControlSizesPx` re-derives that from the class rather than
 * restating it, so editing the class above moves both together.
 */
export function dockControlSizesPx(): { readonly fine: number; readonly coarse: number } {
  const TAILWIND_SPACING_STEP_PX = 4
  const steps = [...DOCK_BUTTON_HEIGHT_CLASS.matchAll(/h-(\d+)/g)].map((match) => Number(match[1]))
  const [fine, coarse] = steps
  if (fine === undefined || coarse === undefined) {
    throw new Error(
      `DOCK_BUTTON_HEIGHT_CLASS lost one of its two sizes: ${DOCK_BUTTON_HEIGHT_CLASS}`,
    )
  }
  return { fine: fine * TAILWIND_SPACING_STEP_PX, coarse: coarse * TAILWIND_SPACING_STEP_PX }
}

const DOCK_BUTTON_WIDTH_CLASS = 'w-9 pointer-coarse:w-11'

// Press feedback and the transition property list live here rather than on one
// side: the cluster had `active:scale` and the palette did not, so half the row
// answered a press and half looked inert. Shared also avoids a second
// order-dependent conflict — `transition-colors` and
// `transition-[transform,...]` both set transition-property, so composing them
// would reintroduce exactly the width bug this module exists to remove.
const DOCK_BUTTON_BASE_CLASS =
  'flex items-center justify-center rounded-md text-muted-foreground transition-[transform,color,background-color] duration-(--motion-duration-fast) ease-(--motion-ease-out) hover:bg-accent hover:text-foreground active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/** A square dock control (icon only). */
export const DOCK_BUTTON_CLASS = `${DOCK_BUTTON_BASE_CLASS} ${DOCK_BUTTON_HEIGHT_CLASS} ${DOCK_BUTTON_WIDTH_CLASS}`

/** A dock control whose content sets its width (the zoom readout). */
export const DOCK_WIDE_BUTTON_CLASS = `${DOCK_BUTTON_BASE_CLASS} ${DOCK_BUTTON_HEIGHT_CLASS} min-w-12 px-1.5`
