import { describe, expect, it } from 'vitest'

// Eager: Vite inlines every source as a string at build time, exactly as
// canvas-render's import-guard.test.ts does. A lazy glob makes each case
// await a per-file transform, and scanning the whole directory serially
// that way overran the 5s default under a saturated worker pool.
const modules = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string | undefined>

// The theme threading in editor-appearance.ts/scene-render.ts must stay a
// pure function of its `theme` argument — no ambient DOM read. viewport.ts
// and node-factories.ts join for the same reason (pan/zoom math and node
// construction must never read a global) — commands.ts does NOT join: its
// existing prose ("...at another document. A stale subpath...") trips the
// `document.`-tripwire below on a sentence boundary, not a real impurity,
// and loosening the regex to admit it would weaken the guard for every
// other file. Scoped to exactly this list (not the whole directory) so a
// rename or a new file silently falling out of the scan is caught by the
// explicit-path assertion below, rather than the guard quietly covering
// zero files.
const SCANNED_PATHS = [
  './editor-appearance.ts',
  './scene-render.ts',
  './viewport.ts',
  './node-factories.ts',
]

describe('theme resolver purity (no ambient DOM read)', () => {
  it('scans exactly the expected files', () => {
    for (const path of SCANNED_PATHS) {
      expect(Object.keys(modules)).toContain(path)
    }
  })

  for (const path of SCANNED_PATHS) {
    it(`${path} reads no window/document/matchMedia/navigator global`, () => {
      const loader = modules[path]
      const source = loader as string
      expect(source).not.toMatch(/\bwindow\./)
      expect(source).not.toMatch(/\bdocument\./)
      expect(source).not.toMatch(/\bmatchMedia\(/)
      expect(source).not.toMatch(/\bnavigator\./)
    })

    // Id minting stays injected (a `createId` argument) precisely so a pure
    // module never needs an ambient id source — these two catch a
    // regression mechanically instead of relying on review. React
    // imports/hooks are the other ambient-state door a "pure" module could
    // sneak through (closing over component state via a hook).
    it(`${path} imports no React and calls no React hook`, () => {
      const loader = modules[path]
      const source = loader as string
      expect(source).not.toMatch(/\bfrom ['"]react['"]/)
      expect(source).not.toMatch(/\buse(State|Ref|Effect|Callback|Memo)\(/)
    })

    it(`${path} references no ambient crypto`, () => {
      const loader = modules[path]
      const source = loader as string
      expect(source).not.toMatch(/\bcrypto\./)
    })
  }

  it('editor-appearance.ts carries no bare color literal (it is a thin adapter, no palette of its own)', () => {
    // Since the theme-layer slice, every color literal lives in
    // canvas-render's shared palette (theme/spatial-palette.ts) — this file
    // only re-projects that shared palette's values, so it should carry NO
    // hex literal at all, not even inside a palette record of its own.
    const loader = modules['./editor-appearance.ts']
    const source = loader as string
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('file seams reach every render path', () => {
  it('SpatialEditor builds its file-seam options once and spreads them everywhere', () => {
    // Four render paths draw the same nodes — committed scene, drag ghost,
    // drag-static backdrop, resize preview. When each listed the seams by
    // hand, adding one meant remembering four places, and the failure mode
    // is silent: content that renders committed and vanishes mid-gesture.
    const source = modules['./SpatialEditor.tsx'] as string
    expect(source.match(/const fileSeamOptions = useMemo\(/g) ?? []).toHaveLength(1)
    // Two entry points build scenes now, not one: the committed path goes
    // through `useWorkerScene` (which lays out in a worker and falls back to
    // `renderCanvasToSvg` itself), while the gesture overlays still call the
    // synchronous builder directly. Counting only one of them would let a
    // seam go missing from the other — which is the whole failure this pins.
    // Stated as the property rather than a count: every call that builds a
    // scene must receive the SHARED seam object. It is spread into an options
    // literal at the synchronous call sites and passed whole at the worker
    // one (that hook memoizes on its identity, so spreading there would
    // rebuild the options every render and defeat it) — counting one spelling
    // would miss the other, and counting both matched dependency arrays too.
    const callsWithoutSeams = [...source.matchAll(/renderCanvasToSvg\(|useWorkerScene\(/g)]
      .map((match) => ({
        at: match.index ?? 0,
        window: source.slice(match.index ?? 0, (match.index ?? 0) + 300),
      }))
      .filter((call) => !call.window.includes('fileSeamOptions'))
      .map((call) => source.slice(call.at, call.at + 60))
    expect(callsWithoutSeams, 'scene-building calls not given the shared seam object').toEqual([])
    // A seam named at a call site instead of inside the shared object is the
    // regression this pins.
    expect(source).not.toMatch(/renderCanvasToSvg\([\s\S]{0,400}?resolveReference,/)
  })
})

describe('single content path (S10 guardrail)', () => {
  it('raw HTML injection exists ONLY at the two documented scene-svg sinks', () => {
    // String-level TRIPWIRE, not a syntax-aware proof: it catches the ways
    // raw markup realistically enters a React/DOM codebase
    // (dangerouslySetInnerHTML, innerHTML/outerHTML assignment,
    // insertAdjacentHTML). The escaping guarantee itself lives in
    // canvas-render's serializer tests — this test only pins that nothing
    // BUT that serializer's two documented injection points exists here.
    const allowed = new Map([
      // Committed scene + the live-edges drag overlay + the live-node
      // resize overlay, all fed solely by canvas-render's escaping
      // serializer.
      ['./SpatialEditor.tsx', 3],
      ['./DragPreviewLayer.tsx', 1],
    ])
    const sinkPattern =
      /dangerouslySetInnerHTML=|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\(/g
    for (const [path, loader] of Object.entries(modules)) {
      if (/\.(test|spec)\.(ts|tsx)$/.test(path)) continue
      const source = loader as string
      const injections = (source.match(sinkPattern) ?? []).length
      expect({ path, injections }).toEqual({ path, injections: allowed.get(path) ?? 0 })
    }
  })

  it('canvas mutations construct typed EditorCommands (no setter bypasses applyCommand)', () => {
    // The palette and every tool mode mutate the canvas exclusively by
    // dispatching an EditorCommand through applyCommand — a hand-rolled
    // canvas object spread reaching onChange directly would bypass the
    // command layer sync consumers replay.
    const loader = modules['./SpatialEditor.tsx']
    const source = loader as string
    // String-level TRIPWIRE for the command boundary: every statement-level
    // onChange call must hand over a canvas spelled `running` (the
    // applyCommand accumulator) or an inline `applyCommand(...)` result.
    // This is deliberately formatting-sensitive and NOT data-flow analysis —
    // a rename or a bypass shows up as a diff in this file, and the
    // behavioral guarantee (sync consumers can replay commands) is carried
    // by the browser-tier tests that assert commands reconstruct the
    // canvas. Prose mentions inside comments don't match: only call sites
    // preceded by code punctuation/whitespace count.
    const callSites = (source.match(/[^`\w]onChange\((running\b|applyCommand\()/g) ?? []).length
    const allCalls = (source.match(/[^`\w]onChange\(/g) ?? []).length
    expect(allCalls).toBe(callSites)
  })
})
