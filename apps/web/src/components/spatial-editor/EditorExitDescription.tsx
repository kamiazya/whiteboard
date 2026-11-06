import { hasCoarsePointer, isMacPlatform } from '../../lib/platform.js'

/**
 * What a screen reader hears after an editor's name: the two ways out, in this
 * platform's key. `escapeKeeps` is for a host whose Escape keeps the draft (a
 * note created for this edit, once something is typed in it); `singleLine` for
 * a one-line field, which a bare Enter keeps. On a touch screen the editor
 * shows its Done and Cancel buttons, and a phone's keyboard has neither key,
 * so the buttons are what is named.
 */
function editorExitDescription(escapeKeeps: boolean, singleLine: boolean): string {
  if (hasCoarsePointer())
    return escapeKeeps ? '✓ Done or ✕ Cancel keeps the note' : '✓ Done keeps, ✕ Cancel discards'
  const keep = singleLine ? 'Enter' : `${isMacPlatform() ? 'Command' : 'Ctrl'}+Enter`
  return escapeKeeps ? `Escape or ${keep} keeps the note` : `Escape discards, ${keep} keeps`
}

/**
 * The text an in-place editor points `aria-describedby` at. Visible readers
 * get the same words from the exit strip; this is the copy that does not
 * depend on seeing it.
 */
export function EditorExitDescription({
  id,
  escapeKeeps = false,
  singleLine = false,
}: {
  readonly id: string
  readonly escapeKeeps?: boolean
  readonly singleLine?: boolean
}) {
  return (
    <span id={id} className="sr-only">
      {editorExitDescription(escapeKeeps, singleLine)}
    </span>
  )
}
