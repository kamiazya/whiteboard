import { isMacPlatform } from '../../lib/platform.js'

/**
 * What a screen reader hears after an editor's name: the two ways out, in this
 * platform's key. `escapeKeeps` is for a host whose Escape keeps the draft (a
 * note created for this edit, once something is typed in it).
 */
function editorExitDescription(escapeKeeps: boolean): string {
  const keep = `${isMacPlatform() ? 'Command' : 'Ctrl'}+Enter`
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
}: {
  readonly id: string
  readonly escapeKeeps?: boolean
}) {
  return (
    <span id={id} className="sr-only">
      {editorExitDescription(escapeKeeps)}
    </span>
  )
}
