/**
 * The editor surface inside a rendered test container. One definition for
 * the spatial-editor browser tests, which mount the editor through
 * `spatial-editor-host.tsx` and find it again through this — a local copy is
 * refused by `tools/arch-lint`'s `spatial-editor-host-one-place.test.ts`. A
 * query for something INSIDE the surface (a polyline, a text) still names the
 * testid in its own selector.
 */
export function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

/**
 * Element-relative position ON the first drawn edge, derived from the
 * committed polyline's own client rect — the space `rightClick` and the
 * pointer helpers take. Hardcoded canvas coordinates break under the vitest
 * browser iframe's UI scaling (the page renders scaled, so a fixed
 * element-relative point lands elsewhere in canvas space depending on the
 * current scale); rect-derived positions live in the same scaled space as the
 * click and stay correct at any zoom.
 */
export function edgeMidpoint(container: HTMLElement): { x: number; y: number } {
  const root = rootOf(container)
  const polyline = container.querySelector(
    '[data-testid="spatial-editor"] svg polyline',
  ) as SVGPolylineElement
  const edgeRect = polyline.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  return {
    x: edgeRect.x + edgeRect.width / 2 - rootRect.x,
    y: edgeRect.y + edgeRect.height / 2 - rootRect.y,
  }
}
