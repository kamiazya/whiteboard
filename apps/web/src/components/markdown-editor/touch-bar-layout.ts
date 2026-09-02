import { hasCoarsePointer } from '../../lib/platform.js'
import { getActiveMarkdownEditor } from './active-markdown-editor.js'

/**
 * The keyboard-docked bar's slot arithmetic, shared by the bar and its
 * test. Slot and height are the dock's coarse-pointer control size
 * (`DOCK_BUTTON_CLASS`); the divider is a 1px line with 3px on each side.
 */
export const TOUCH_BAR_HEIGHT_PX = 44
export const TOUCH_BAR_SLOT_PX = 44
export const TOUCH_BAR_DIVIDER_PX = 7
export const TOUCH_BAR_PADDING_PX = 4

export interface TouchBarItem<Id, Band> {
  readonly id: Id
  readonly band: Band
}

export interface TouchBarLayout<Id> {
  /** In order; a prefix of the items given. */
  readonly visible: readonly Id[]
  /** The rest, in order — what the "…" sheet lists. Empty means no "…". */
  readonly overflow: readonly Id[]
}

/** Width of the first `count` items laid out with a divider at each band change. */
function widthOfPrefix<Id, Band>(items: readonly TouchBarItem<Id, Band>[], count: number): number {
  let width = 0
  for (let i = 0; i < count; i++) {
    if (i > 0 && items[i].band !== items[i - 1].band) width += TOUCH_BAR_DIVIDER_PX
    width += TOUCH_BAR_SLOT_PX
  }
  return width
}

/**
 * Which items fit at `widthPx`, in priority order, and which go behind
 * "…". Everything fits -> no "…" slot at all; otherwise the longest prefix
 * that leaves room for a divider and the "…" slot is shown, and a width too
 * small for even one item still shows "…" alone.
 */
export function layoutTouchBar<Id, Band>(
  widthPx: number,
  items: readonly TouchBarItem<Id, Band>[],
): TouchBarLayout<Id> {
  const available = widthPx - 2 * TOUCH_BAR_PADDING_PX
  const ids = items.map((item) => item.id)
  if (widthOfPrefix(items, items.length) <= available) return { visible: ids, overflow: [] }
  let count = 0
  for (let n = items.length - 1; n >= 1; n--) {
    if (widthOfPrefix(items, n) + TOUCH_BAR_DIVIDER_PX + TOUCH_BAR_SLOT_PX <= available) {
      count = n
      break
    }
  }
  return { visible: ids.slice(0, count), overflow: ids.slice(count) }
}

/**
 * Whether the formatting bar is on screen. The one answer both the bar's own
 * gate and keyboard avoidance's clearance ask, so a node can never be panned
 * up to clear a strip that is not there.
 *
 * Not `hasCoarsePointer()` alone, which is what made them disagree: an edge
 * or group LABEL is edited in a plain textarea (`TextNodeEditor`), which
 * registers no markdown host, so the bar stays away for that edit while the
 * pointer is just as coarse.
 */
export function touchFormattingBarShown(): boolean {
  return getActiveMarkdownEditor() !== null && hasCoarsePointer()
}
