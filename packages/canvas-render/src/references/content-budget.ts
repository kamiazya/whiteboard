import { MARKDOWN_MAX_CHARS, nodeText, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { canvasElementCount, NESTED_ELEMENT_BUDGET } from '../layout/nodes/embed-budget.js'
import type { LoadedReference } from './loaded-reference.js'

/**
 * How many characters of referenced CONTENT one walk may load between its
 * documents — bodies, and the text of a canvas's nodes.
 *
 * `REFERENCE_BUDGET` counts target strings, and a string is priced by what
 * it names: 256 of them naming notes at `MARKDOWN_MAX_CHARS` is 64M
 * characters to read, decode and answer for one render. Four maximal notes
 * is far more nested prose than any embed draws legibly, so past it a
 * reference is drawn by its name alone.
 */
export const REFERENCE_CHARS_BUDGET = 4 * MARKDOWN_MAX_CHARS

/**
 * How many canvas elements the referenced canvases of one walk may load —
 * the layout's own `NESTED_ELEMENT_BUDGET`, because loading a board the
 * layout will refuse to draw buys nothing.
 */
export const REFERENCE_ELEMENTS_BUDGET = NESTED_ELEMENT_BUDGET

/** What one loaded reference charges the account. */
function referenceContentCost(entry: LoadedReference): {
  readonly chars: number
  readonly elements: number
} {
  return {
    chars: (entry.body?.length ?? 0) + canvasTextChars(entry.canvas),
    elements: canvasElementCount(entry.canvas),
  }
}

function canvasTextChars(canvas: SpatialCanvas | undefined): number {
  let chars = 0
  for (const node of canvas?.nodes ?? []) chars += nodeText(node)?.length ?? 0
  return chars
}

/**
 * One walk's running account of referenced content.
 *
 * A keeper learns what a document costs only by reading it, so the account
 * is checked BEFORE a read (`closed`: past it, do not read) and charged
 * after (`admit`). An entry that does not fit is answered by its name and
 * CLOSES the account, so what a walk reads is bounded by the budget plus
 * one document — a smaller document after a refused one is not read either,
 * since each read past the budget is the cost being bounded.
 */
export interface ReferenceContentAccount {
  readonly closed: boolean
  /** The entry whole if it fits — charging it — or its name alone. */
  admit(entry: LoadedReference): LoadedReference
}

/** The name a reference past the budget is drawn by: no body, no canvas. */
function referenceNameOnly(entry: LoadedReference): LoadedReference {
  return {
    ...(entry.documentId === undefined ? {} : { documentId: entry.documentId }),
    ...(entry.name === undefined ? {} : { name: entry.name }),
  }
}

export function createReferenceContentAccount(): ReferenceContentAccount {
  let chars = REFERENCE_CHARS_BUDGET
  let elements = REFERENCE_ELEMENTS_BUDGET
  let closed = false
  return {
    get closed() {
      return closed
    },
    admit(entry) {
      if (closed) return referenceNameOnly(entry)
      const cost = referenceContentCost(entry)
      if (cost.chars > chars || cost.elements > elements) {
        closed = true
        return referenceNameOnly(entry)
      }
      chars -= cost.chars
      elements -= cost.elements
      return entry
    },
  }
}
