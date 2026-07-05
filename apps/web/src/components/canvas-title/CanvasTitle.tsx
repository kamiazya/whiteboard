import { useRef, useState, type KeyboardEvent } from 'react'

interface CanvasTitleProps {
  value: string
  onRename: (name: string) => void
}

// Excalidraw registers document-level keydown/keyup handlers for its shortcuts
// (delete selection, clear, etc). Without stopPropagation here, typing Enter/
// Escape/Backspace/Delete into this field would also trigger those canvas
// shortcuts.
function stopPropagation(event: KeyboardEvent<HTMLInputElement>): void {
  event.stopPropagation()
}

export function CanvasTitle({ value, onRename }: CanvasTitleProps) {
  // Initialized once from the incoming value. CanvasTitle is remounted
  // whenever the underlying canvas identity changes (load-degraded /
  // cleanup-completed / startFresh all unmount this component), so there is
  // no live external-rename case that requires re-syncing draft from a
  // changed `value` prop while mounted — Escape below covers the only
  // in-place revert this component needs.
  const [draft, setDraft] = useState(value)
  // Escape reverts without committing; the ensuing blur() call must not also
  // fire the blur-commit handler, so suppress exactly the next blur.
  const suppressNextBlurRef = useRef(false)

  function commit() {
    if (suppressNextBlurRef.current) {
      suppressNextBlurRef.current = false
      return
    }
    const normalized = draft.trim() || 'untitled'
    onRename(normalized)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    stopPropagation(event)
    if (event.key === 'Enter') {
      commit()
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      suppressNextBlurRef.current = true
      setDraft(value)
      event.currentTarget.blur()
    }
  }

  return (
    <input
      type="text"
      aria-label="Canvas title"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={handleKeyDown}
      onKeyUp={stopPropagation}
      onBlur={commit}
      className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-semibold outline-none transition-colors hover:border-border focus:border-border focus:bg-background"
    />
  )
}
