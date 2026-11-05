/**
 * What to press while the Connect tool is armed. Connecting is two presses —
 * the first note, then the second — and an armed tool looks like every other
 * pressed dock button, so without this the canvas gives no sign of either
 * step. Worded for the pointer in hand; the first line is also what the tool
 * announces, so a screen reader hears it once, with the tool's name.
 *
 * `pointer-events-none`: it must never catch the press it is asking for.
 */
export function connectToolHint(coarse: boolean): string {
  return coarse ? 'Tap the first note, then the second' : 'Click the first note, then the second'
}

export function ConnectToolHint({
  coarse,
  armed,
}: {
  readonly coarse: boolean
  /** The first note is chosen: what is left is the second. */
  readonly armed: boolean
}) {
  return (
    <p
      data-testid="connect-tool-hint"
      className="pointer-events-none absolute top-3 left-1/2 z-10 max-w-[calc(100%-8rem)] -translate-x-1/2 rounded-full border bg-background px-3 py-1.5 text-center text-sm text-muted-foreground shadow-sm select-none"
    >
      {armed ? `Now ${coarse ? 'tap' : 'click'} the note to connect to` : connectToolHint(coarse)}
    </p>
  )
}
