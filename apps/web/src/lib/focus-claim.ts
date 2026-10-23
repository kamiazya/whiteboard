// Which surface may take focus on its own (autofocus) is decided by one fact
// the DOM cannot keep: that the reader already placed focus somewhere
// deliberately. A rename navigates and remounts the page, so by the time the
// editor mounts `document.activeElement` is `<body>` again and looks exactly
// like "nobody has chosen yet" — the remembered placement is what tells the
// two apart.

/**
 * ponytail: a fixed window rather than tying the claim to a document id.
 * Every autofocus the app does happens within a second or two of a
 * navigation, so ten seconds covers a slow remount without muting the
 * autofocus of the next note a reader opens a moment later; a per-document
 * key would need the page to thread an id the editor does not otherwise know.
 */
const PLACEMENT_WINDOW_MS = 10_000

let lastPlacedAt: number | null = null

/** Records that the reader chose a field to type in (focus or keystroke). */
export function noteFocusPlaced(now: number = Date.now()): void {
  lastPlacedAt = now
}

/** Whether a surface may claim focus unprompted at `now`. */
export function mayAutofocus(now: number = Date.now()): boolean {
  return lastPlacedAt === null || now - lastPlacedAt >= PLACEMENT_WINDOW_MS
}

export function resetFocusClaim(): void {
  lastPlacedAt = null
}
