/**
 * The one-line cue on a canvas with nothing on it. An empty canvas is
 * otherwise a blank sheet: creation lives behind the dock's "+" and a
 * double-click on empty space, and neither is visible until you already know
 * it. Names only what is real on each pointer — there is no keyboard
 * shortcut for a new note, so none is promised.
 *
 * `pointer-events-none`: it must never catch the press that creates the note.
 */
export function CanvasEmptyHint({
  coarse,
  id,
}: {
  readonly coarse: boolean
  /** What the canvas root's `aria-describedby` names, so the cue is read with it. */
  readonly id: string
}) {
  return (
    <p
      id={id}
      data-testid="canvas-empty-hint"
      className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground select-none"
    >
      {coarse ? 'Tap + to add a note' : 'Double-click to add a note'}
    </p>
  )
}
