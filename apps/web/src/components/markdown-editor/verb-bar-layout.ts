import { hasCoarsePointer } from '../../lib/platform.js'
import { getActiveMarkdownEditor } from './active-markdown-editor.js'

/**
 * A verb bar's slot arithmetic, shared by both bars and their tests: the
 * keyboard-docked one a phone gets, and the one a desktop shows under the
 * header. Only the SLOT SIZE differs between them, so the fitting is one
 * function taking the metrics rather than two copies drifting apart.
 *
 * A divider is a 1px line with 3px on each side, at either size.
 */
export interface VerbBarMetrics {
  readonly slotPx: number
  readonly dividerPx: number
  readonly paddingPx: number
}

/** The dock's coarse-pointer control size (`DOCK_BUTTON_CLASS`). */
export const TOUCH_BAR_HEIGHT_PX = 44
export const TOUCH_BAR_METRICS: VerbBarMetrics = { slotPx: 44, dividerPx: 7, paddingPx: 4 }

/**
 * The editor toolbar's own control size (`size-7`), so the verbs read as
 * part of that strip rather than as a band bolted on to it. The height is
 * the toolbar row's — a desktop bar adds no row of its own.
 */
export const DESKTOP_BAR_HEIGHT_PX = 40
export const DESKTOP_BAR_METRICS: VerbBarMetrics = { slotPx: 28, dividerPx: 7, paddingPx: 4 }

export interface VerbBarItem<Id, Band> {
  readonly id: Id
  readonly band: Band
}

export interface VerbBarLayout<Id> {
  /** In order; a prefix of the items given. */
  readonly visible: readonly Id[]
  /** The rest, in order — what the "…" sheet lists. Empty means no "…". */
  readonly overflow: readonly Id[]
}

/** Width of the first `count` items laid out with a divider at each band change. */
function widthOfPrefix<Id, Band>(
  items: readonly VerbBarItem<Id, Band>[],
  count: number,
  metrics: VerbBarMetrics,
): number {
  let width = 0
  for (let i = 0; i < count; i++) {
    if (i > 0 && items[i].band !== items[i - 1].band) width += metrics.dividerPx
    width += metrics.slotPx
  }
  return width
}

/**
 * Which items fit at `widthPx`, in priority order, and which go behind
 * "…". Everything fits -> no "…" slot at all; otherwise the longest prefix
 * that leaves room for a divider and the "…" slot is shown, and a width too
 * small for even one item still shows "…" alone.
 */
export function layoutVerbBar<Id, Band>(
  widthPx: number,
  items: readonly VerbBarItem<Id, Band>[],
  metrics: VerbBarMetrics,
): VerbBarLayout<Id> {
  const available = widthPx - 2 * metrics.paddingPx
  const ids = items.map((item) => item.id)
  if (widthOfPrefix(items, items.length, metrics) <= available)
    return { visible: ids, overflow: [] }
  let count = 0
  for (let n = items.length - 1; n >= 1; n--) {
    if (widthOfPrefix(items, n, metrics) + metrics.dividerPx + metrics.slotPx <= available) {
      count = n
      break
    }
  }
  return { visible: ids.slice(0, count), overflow: ids.slice(count) }
}

/**
 * Whether the keyboard-docked (touch) bar is on screen. The one answer both the bar's own
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
