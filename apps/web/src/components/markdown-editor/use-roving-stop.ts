import { type KeyboardEvent, useState } from 'react'

/**
 * One Tab stop for a row of buttons: the one last focused (the first until
 * then), with Left/Right wrapping and Home/End jumping between them. Shift+Tab
 * back into the row therefore lands where the reader was.
 */
export function useRovingStop<Id extends string>(
  ids: readonly Id[],
): {
  stop: Id | undefined
  onFocusItem: (id: Id) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
} {
  const [stopId, setStopId] = useState<Id | null>(null)
  const stop = stopId !== null && ids.includes(stopId) ? stopId : ids[0]
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const target = {
      ArrowRight: (at + 1) % buttons.length,
      ArrowLeft: (at - 1 + buttons.length) % buttons.length,
      Home: 0,
      End: buttons.length - 1,
    }[event.key]
    if (target === undefined) return
    event.preventDefault()
    buttons[target]?.focus()
  }
  return { stop, onFocusItem: setStopId, onKeyDown }
}
