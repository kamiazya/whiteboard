import { useCallback, useState } from 'react'
import { type PenStyle, readPen, writePen } from '../../lib/spatial/pen-style.js'

/** The Draw tool's pen, remembered for the tab across every canvas it opens. */
export function usePen(): readonly [PenStyle, (pen: PenStyle) => void] {
  const [pen, setPenState] = useState(readPen)
  const setPen = useCallback((next: PenStyle) => {
    setPenState(next)
    writePen(next)
  }, [])
  return [pen, setPen] as const
}
