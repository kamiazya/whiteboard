/**
 * Pointer capture is best-effort chrome, not a correctness requirement: a
 * browser can reject it (e.g. `NotFoundError` for a pointerId the platform
 * has no active record of, which synthetic/programmatic pointer dispatch
 * can trigger). Callers register no window-level fallback listeners, so a
 * rejected or lost capture is recovered through `lostpointercapture`, which
 * ends whatever drag is in flight.
 */
export function trySetPointerCapture(root: HTMLElement, pointerId: number): void {
  try {
    root.setPointerCapture(pointerId)
  } catch {
    // best-effort — see doc comment above
  }
}
