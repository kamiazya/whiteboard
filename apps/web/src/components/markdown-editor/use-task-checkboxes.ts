import type { KeyedSvgRender } from '@kamiazya/whiteboard-canvas-render'
import {
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
} from 'react'
import { taskLineNumbers } from '../../lib/task-toggle.js'

const CHECKBOX = '[role="checkbox"]'

/**
 * Makes the task checkboxes the preview drew into `hostRef` operable: a click
 * or Enter/Space on one reports the source line of its item.
 *
 * The i-th drawn box is the i-th task line of `source`. The counts must agree
 * or the activation is dropped: a box with no line behind it (an embedded
 * note's) would otherwise toggle somebody else's.
 */
export function useTaskCheckboxes(
  source: string,
  keyed: KeyedSvgRender,
  onToggleTask: ((line: number) => void) | undefined,
): {
  hostRef: MutableRefObject<HTMLDivElement | null>
  handlers: {
    onClick?: (event: MouseEvent<HTMLDivElement>) => void
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  }
} {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const toggleFrom = useCallback(
    (target: EventTarget | null): boolean => {
      const host = hostRef.current
      const box = target instanceof Element ? target.closest(CHECKBOX) : null
      if (host === null || box === null || onToggleTask === undefined) return false
      const drawn = Array.from(host.querySelectorAll(CHECKBOX))
      const lines = taskLineNumbers(source)
      const line = lines[drawn.indexOf(box)]
      if (drawn.length !== lines.length || line === undefined) return false
      onToggleTask(line)
      return true
    },
    [onToggleTask, source],
  )
  // Declared after the keyed patcher's layout effect has run for this commit,
  // so the boxes it just painted are the ones made focusable.
  useEffect(() => {
    if (onToggleTask === undefined) return
    for (const box of hostRef.current?.querySelectorAll(CHECKBOX) ?? []) {
      box.setAttribute('tabindex', '0')
    }
  }, [keyed, onToggleTask])
  if (onToggleTask === undefined) return { hostRef, handlers: {} }
  return {
    hostRef,
    handlers: {
      onClick: (event) => {
        toggleFrom(event.target)
      },
      onKeyDown: (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && toggleFrom(event.target)) {
          event.preventDefault()
        }
      },
    },
  }
}
