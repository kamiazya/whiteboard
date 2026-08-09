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
