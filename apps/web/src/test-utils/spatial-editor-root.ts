/**
 * The editor surface inside a rendered test container. One definition for
 * every spatial-editor browser test; a local copy or an inline
 * `querySelector` of the testid is the duplication this replaces.
 */
export function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

/**
 * The midpoint of the first drawn edge, in the editor root's own coordinates
 * — the space `rightClick` and the pointer helpers take.
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
