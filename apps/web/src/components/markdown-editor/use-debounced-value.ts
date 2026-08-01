import { useEffect, useState } from 'react'

/**
 * Trailing-edge debounce: settles on the LAST value seen once `delayMs` has
 * elapsed with no further change. Used to keep the preview pane from
 * re-parsing/re-laying-out markdown synchronously on every keystroke.
 *
 * The pending timer is cleared on every re-render and on unmount, so a
 * fast-typing user never triggers more than one render's worth of pending
 * work, and no update ever lands on an unmounted component.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
