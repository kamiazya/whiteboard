import { isMacPlatform } from '../../lib/platform.js'

/** What a screen reader hears after an editor's name: the two ways out, in this platform's key. */
export function editorExitDescription(): string {
  return `Escape discards, ${isMacPlatform() ? 'Command' : 'Ctrl'}+Enter keeps`
}

/**
 * The text an in-place editor points `aria-describedby` at. Visible readers
 * get the same words from the exit strip; this is the copy that does not
 * depend on seeing it.
 */
export function EditorExitDescription({ id }: { readonly id: string }) {
  return (
    <span id={id} className="sr-only">
      {editorExitDescription()}
    </span>
  )
}
