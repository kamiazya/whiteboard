/**
 * The box a comment is written in — a real markdown editor, because a
 * comment's body IS markdown.
 *
 * It is the same CodeMirror host the note's source pane is (`SourcePane`),
 * in its compact variant: the same GFM grammar, the same achromatic syntax
 * highlighting, the same closed verb set behind `Mod-b` and friends. A
 * second editor beside it would be a second answer to "what can I write
 * here", and the two would drift the way every other pair in this layer
 * has.
 *
 * Two chords, and they are the ones every editing surface in this app
 * already answers:
 *
 * - **Enter is a newline.** A comment is prose, and a box that sends on
 *   Enter eats paragraph breaks — worse than one extra chord.
 * - **Mod+Enter sends.**
 *
 * Registering with the active-editor singleton comes free with the host,
 * and is correct rather than incidental: while the caret is in here, the
 * phone's docked formatting bar should act on THIS box. `composeThread` is
 * absent from what the host registers for a composer — a comment on a
 * comment is not a thing this layer has.
 */
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { type RefObject, useMemo, useRef } from 'react'
import { cn } from '../../lib/utils.js'
import { SourcePane, type SourcePaneApi } from '../markdown-editor/SourcePane.js'

export interface CommentComposerProps {
  readonly value: string
  readonly onChange: (next: string) => void
  /** Mod+Enter. The host decides what an empty draft means. */
  readonly onSubmit: () => void
  /** Names the box for a screen reader and for a test. */
  readonly label: string
  readonly placeholderText?: string
  readonly autoFocus?: boolean
  /** The panel's dense typography; the card inherits the bubble's own. */
  readonly compact?: boolean
  readonly className?: string
  /**
   * The live editor, for a host that moves the caret itself.
   *
   * `autoFocus` covers a box opened from a MENU, whose item is already
   * dismissing when the box mounts — the host deliberately does not steal
   * focus from a real holder. A box opened by an ordinary button (the
   * rail's Edit pencil) has one, so its host asks for the caret explicitly
   * once the box exists.
   */
  readonly apiRef?: RefObject<SourcePaneApi | null>
}

export function CommentComposer({
  value,
  onChange,
  onSubmit,
  label,
  placeholderText,
  autoFocus = false,
  compact = false,
  className,
  apiRef,
}: CommentComposerProps) {
  // The view is created once per mount and closes over its extensions, so
  // the chord has to read the CURRENT handler rather than the one that was
  // in scope when the box opened.
  const submitRef = useRef(onSubmit)
  submitRef.current = onSubmit

  const extensions = useMemo(
    () => [
      // Above the language keymap, which binds Enter for list continuation
      // and would otherwise see this first.
      Prec.highest(
        // BOTH modifiers, not CodeMirror's `Mod-`. `Mod` resolves to Cmd on
        // a Mac and Ctrl everywhere else, so binding it would have taken
        // Ctrl+Enter away from a Mac reader — the textarea this replaces
        // accepted either modifier on every platform, and a chord that
        // works until you change machines is worse than one that never did.
        // Caught by the rail's own Meta+Enter test running on Linux, where
        // `Mod-Enter` is Ctrl and the press did nothing.
        keymap.of(
          (['Mod-Enter', 'Meta-Enter', 'Ctrl-Enter'] as const).map((key) => ({
            key,
            run: () => {
              submitRef.current()
              return true
            },
          })),
        ),
      ),
      // CodeMirror's editable surface is a contenteditable with
      // `role="textbox"`; without this it has no accessible name at all.
      EditorView.contentAttributes.of({
        'aria-label': label,
        'aria-keyshortcuts': 'Meta+Enter Control+Enter',
      }),
    ],
    [label],
  )

  return (
    <SourcePane
      variant="compact"
      value={value}
      onChange={onChange}
      autoFocus={autoFocus}
      {...(apiRef === undefined ? {} : { apiRef })}
      {...(placeholderText === undefined ? {} : { placeholderText })}
      extensions={extensions}
      className={cn(
        'w-full rounded border bg-background',
        compact ? 'text-xs' : 'text-inherit',
        className,
      )}
    />
  )
}
