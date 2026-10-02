const TAILWIND_SPACING_STEP_PX = 4

/**
 * The fine-pointer and coarse-pointer heights a control's class string
 * declares, in pixels, for a layout test that must reason about the COARSE row
 * without being able to render it.
 *
 * The runner exposes no way to emulate `pointer: coarse`, and coarse is the
 * size that collides: a 44px control wrapped in anything with chrome of its own
 * no longer fits a chrome row the 32px fine one leaves room to spare in.
 * Derived from the class rather than restated, so editing the heights moves the
 * test with them. Tailwind's spacing scale is 4px per step.
 */
export function controlHeightsPx(classes: string): {
  readonly fine: number
  readonly coarse: number
} {
  const fine = /(?:^|\s)h-(\d+)(?:\s|$)/.exec(classes)?.[1]
  const coarse = /pointer-coarse:h-(\d+)/.exec(classes)?.[1]
  if (fine === undefined || coarse === undefined) {
    throw new Error(`class string lost one of its two heights: ${classes}`)
  }
  return {
    fine: Number(fine) * TAILWIND_SPACING_STEP_PX,
    coarse: Number(coarse) * TAILWIND_SPACING_STEP_PX,
  }
}
