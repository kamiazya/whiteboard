/**
 * Every piece of React state `SpatialEditor` holds, classified against
 * what `editor-state.property.test.ts` actually models.
 *
 * The companion to the three union ledgers in that file, and the same
 * contract — an entry cannot outlive what it names, and an omission is a
 * failure rather than a silence. The difference is only in what pins the
 * key set: those ride on closed unions the type system already checks, and
 * `useState` calls are not a union, so this one scans the source.
 *
 * It earns its place because the state surface is where both selection
 * defects this model found actually lived. Both were the same shape — a
 * piece of state pinned to an id that the document stopped holding, kept
 * coherent by hand at every call site, invisible at every read site
 * because they all filter by what is currently laid out. Writing the list
 * down turns "which other state has that shape?" from a question nobody
 * asks into a table anyone can read.
 *
 * Source comes from `?raw` at build time, not `node:fs`: apps/web is
 * browser-only and `web-app-boundary.test.ts` enforces it. Same reason
 * `editor-focus-discipline.test.ts` does it that way.
 *
 * `useRef` is deliberately out of scope, and saying so is part of the
 * ledger's job. There are 26 of them, most pure plumbing (`rootRef`) or a
 * mirror of state already listed here (`canvasRef`, `gestureStateRef`);
 * the handful that hold real decisions — `longPressRef`, `doublePressRef`,
 * `lastPressRef`, `spaceDownRef` — are gesture-arming timers whose whole
 * lifetime is inside one pointer interaction, so none can outlive the
 * document the way the entries below can. Worth revisiting if one ever
 * starts holding an element id.
 */
import { describe, expect, it } from 'vitest'
import { assertScannedLedger } from '../../test-utils/coverage-ledger.js'

// The editor plus the hooks its state moved to: an extraction moves state,
// not away, so a moved useState must stay scanned. A new hook that declares
// state joins this list in the same commit that moves it.
const sources = import.meta.glob(
  [
    './SpatialEditor.tsx',
    './use-editor-measurements.ts',
    './use-file-seam-scene.ts',
    './use-viewport-controls.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

type StateCoverage =
  /** The composite-state property drives this and asserts about it. */
  | 'modelled'
  /**
   * Cannot make a verb act on the wrong thing: it decorates the current
   * frame and is recomputed or discarded on the next one. The reason has
   * to say WHY, because "it's only visual" is exactly what was true of
   * the two stale ids until Delete read them back.
   */
  | `view only: ${string}`
  /** Real state the property does not reach yet. The reason names the gap. */
  | `not modelled: ${string}`

const EDITOR_STATE_COVERAGE: Record<string, StateCoverage> = {
  gestureState: 'modelled',
  selectionState: 'modelled',
  selectedEdgeId: 'modelled',
  pendingCut: 'modelled',

  viewport:
    'not modelled: pan/zoom, owned by viewport.property.test.ts — it cannot reach canvas, gesture or selection state',
  tool: 'modelled',
  marquee: 'modelled',

  // The four id-pinned entries. Each resolves its element IN THE RENDER
  // and shows nothing when it is missing, so a stale id here is inert
  // rather than invisible — the opposite of `selectedEdgeId`, whose read
  // sites all filtered by what was laid out while a verb still acted on
  // it. The two dialogs only gained that gate after this table was
  // written; see dialog-target-vanishes.browser.test.tsx.
  edgeLabelEditId:
    'not modelled: pinned to an edge id, gated on finding that edge in the render. Nothing here drives the label editor itself',
  groupLabelEditId: 'not modelled: pinned to a node id, gated on finding that group in the render',
  commentCompose:
    'not modelled: an open compose bubble holding only its anchor; the draft text lives in the bubble. Its commit writes create-comment or set-comment-text, covered by comment-create / comment-edit.browser.test.tsx',
  commentDrag:
    'not modelled: an in-flight pin drag beside the gesture machine (start anchor + live pointer); its release writes move-comment, covered by comment-move.browser.test.tsx',
  linkDialog:
    'not modelled: carries a nodeId in edit mode, gated on finding that node. Its submit writes set-node-url, itself unmodelled',
  canvasPicker:
    'not modelled: carries a nodeId in retarget mode, gated on finding that node. Its submit writes set-node-file, itself unmodelled',

  livePoint:
    'view only: the current pointer position during a gesture, replaced every frame and cleared when the gesture leaves flight. No verb reads it',
  snapGuides:
    'view only: the guide lines justifying an in-flight snap, cleared by the same predicate as livePoint',
  longPressPulse: 'view only: one expanding ring animating the moment a long-press committed',
  contextMenu:
    'view only: whether the menu is open and where. Its ITEMS act on the selection, which is modelled; the menu holds no decision of its own',
  expandedFileIds:
    'view only: the LOD gate deciding which file nodes render an inline miniature at this zoom',
  facetPanelOpen:
    'view only: open or shut. WHICH node the inspector edits follows the selection, deliberately',
  rootSize: 'view only: the measured size of the editor root, an input to layout',
  shellWidth: 'view only: the measured width the inspector reserves',
}

/** `const [name, setName] = useState` — the only form this file uses. */
const USE_STATE = /const \[([a-zA-Z]+), set[a-zA-Z]+\] = useState/g

function scanStateNames(source: string): string[] {
  return [...source.matchAll(USE_STATE)].map((match) => match[1])
}

describe('SpatialEditor state surface', () => {
  const source = Object.values(sources).join('\n')

  it('reads the component source', () => {
    expect(Object.keys(sources).length, 'the ?raw glob matched nothing').toBeGreaterThan(1)
    // A regex that stopped matching would leave this empty, and an empty
    // scan makes every check below vacuous in the direction that matters.
    expect(scanStateNames(source).length, 'the useState scan found almost nothing').toBeGreaterThan(
      15,
    )
  })

  it('classifies every piece of state the component holds', () => {
    assertScannedLedger(scanStateNames(source), EDITOR_STATE_COVERAGE, {
      unclassified:
        'new SpatialEditor state is unclassified — add it to EDITOR_STATE_COVERAGE as "modelled", "view only: <reason>" or "not modelled: <reason>", and if it holds an element id, read what the two selection defects cost first',
      stale: 'EDITOR_STATE_COVERAGE names state SpatialEditor no longer holds — drop the entry',
    })
  })
})
