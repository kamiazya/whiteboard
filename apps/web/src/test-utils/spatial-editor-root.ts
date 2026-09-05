/**
 * The editor surface inside a rendered test container. One definition for
 * the 33 browser test files that all queried the same testid with the same
 * cast — measured identical before extracting (the makeHost builders around
 * it deliberately stay per-file: 34 distinct fixtures, not copies).
 */
export function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}
