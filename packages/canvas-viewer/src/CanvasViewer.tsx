import type {
  LayoutCore,
  MeasureText,
  ReferenceSeams,
  SpatialLayoutOptions,
  SpatialRenderStyle,
  SpatialThemeMode,
} from '@kamiazya/whiteboard-canvas-render'
import {
  type CoreSvgAsk,
  createSpatialTheme,
  layoutSpatialCanvasPicture,
  type SpatialAppearanceResolver,
} from '@kamiazya/whiteboard-canvas-render'
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useMemo } from 'react'
import { hasLoadedFace } from './font-loading.js'
import { createBrowserMeasureText } from './measure-text.js'
import { SceneSvg } from './SceneSvg.js'
import { useViewerFontReady } from './use-viewer-font-ready.js'

/** Which of canvas-render's two shared spatial palettes a viewer draws in. */
export type ViewerTheme = SpatialThemeMode

/**
 * The viewer has no theme switch of its own — it draws in whichever mode its
 * HOST says it is in, through canvas-render's shared `createSpatialTheme`
 * (package-canvas-render.md decision #8). Both resolvers are built once at
 * module scope: they are pure lookup tables, and rebuilding one per render
 * would re-run every layout.
 *
 * `light` is the default because it is the mode a surface with no theme of
 * its own wants — anything embedding a scene into a document — and because export must never vary with a person's UI theme
 * (see apps/web's `editor-appearance.ts`).
 */
const VIEWER_APPEARANCES = {
  light: createSpatialTheme({ mode: 'light' }),
  dark: createSpatialTheme({ mode: 'dark' }),
} as const satisfies Record<ViewerTheme, SpatialAppearanceResolver>

export interface CanvasViewerProps {
  canvas: SpatialCanvas
  width?: CoreSvgAsk['width']
  height?: CoreSvgAsk['height']
  padding?: CoreSvgAsk['padding']
  background?: CoreSvgAsk['background']
  /** Injection seam for tests; defaults to the real Canvas 2D measurer. */
  measure?: MeasureText
  /**
   * What the host knows about the documents this canvas points at, as the
   * one bundle `referenceSeams` builds — a readable name, a referenced
   * markdown document's body, a referenced canvas.
   *
   * Synchronous by canvas-render's contract, which is why this package
   * takes the resolution as data rather than fetching it: the viewer is
   * read-only and has no store. The host supplies it, since the keeper is
   * the only side that can read another document. Absent keeps the plain reference
   * card.
   */
  references?: ReferenceSeams
  /**
   * The math blocks and diagram fences the host has already rendered, as
   * canvas-render's fragment TABLE: `fragments` by `fragmentAskKey`, DATA
   * because a function cannot cross into the Rust core. A source the table
   * lacks keeps its fallback (the escaped-source placeholder, a plain code
   * block) and is handed to `onFragmentsAsked`, once each, which a host
   * answers by rendering it and passing a new table. Absent, every source
   * keeps its fallback.
   */
  fragments?: Pick<SpatialLayoutOptions, 'fragments' | 'onFragmentsAsked'>
  /**
   * The Rust core (ADR-0054), which this package never loads itself: the
   * host owns the wasm instance and hands it over, and it lays the board out.
   */
  core: LayoutCore
  /**
   * The document's conversations, for the chrome the flat comments inside
   * `canvas` cannot carry — a passage's highlight, a node set's outline.
   * The pins still come from the canvas's own projection.
   */
  threads?: readonly CommentThread[]
  /**
   * Which look to draw (ADR-0030 decision 6). Absent is `'clean'`: a widget
   * or an embedding host never pays for a theme's jittered geometry or glow
   * unasked. `'document'` draws the theme the canvas names; a theme id
   * previews one.
   */
  style?: SpatialRenderStyle
  /**
   * Which shared palette to draw in. Defaults to `light`, so a host that
   * says nothing renders exactly the bytes it always has.
   *
   * A read-only surface inside a themed app has to be told: the SVG is
   * injected markup, so CSS cannot reach the fills and strokes
   * canvas-render resolved at layout time. Body text runs are the one
   * exception — canvas-render assigns them no `fill`, so they inherit it
   * from the host element (see apps/web's preview and editor, which both
   * set one).
   */
  theme?: ViewerTheme
  testId?: string
  /**
   * Accessible name for the rendered canvas. The viewer cannot derive one:
   * a document's name lives in the workspace, never in canvas content (see
   * vocabulary.md), so the host supplies it and `DEFAULT_LABEL` is only the
   * floor.
   */
  label?: string
}

const DEFAULT_TEST_ID = 'canvas-viewer'
const DEFAULT_LABEL = 'Canvas'

export function CanvasViewer({
  canvas,
  width,
  height,
  padding,
  background,
  measure,
  references,
  fragments,
  core,
  threads,
  style,
  theme = 'light',
  testId = DEFAULT_TEST_ID,
  label = DEFAULT_LABEL,
}: CanvasViewerProps) {
  // What the host did not say. The picture is drawn at the scene's own size
  // and scaled by CSS into the figure (owner decision q89): a host resize
  // then costs no layout and no serialization, and `preserveAspectRatio`'s
  // default fits it exactly as drawing it at the box's size did.
  const hostSized = width === undefined && height === undefined
  // Stable across re-renders of the same component instance so layoutSpatialCanvas
  // doesn't recreate the (lazily-created) Canvas 2D context on every render.
  const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])

  // Kicks off (or joins) the shared viewer-font load and flips true once the
  // real face is loaded — a host that never goes through apps/web's
  // main.tsx bound wait (a test, an embedding page) gets it here, so this
  // component is the fallback seam that still eventually
  // re-measures with the real face instead of staying on fallback metrics
  // for its whole lifetime. Included in the svg memo's deps so the SVG is
  // recomputed exactly when readiness ticks, not on every render.
  const fontReady = useViewerFontReady()

  const svg = useMemo(() => {
    const { svg: drawn } = layoutSpatialCanvasPicture(
      canvas,
      {
        measure: resolvedMeasure,
        appearance: VIEWER_APPEARANCES[theme],
        ...(style === undefined ? {} : { style }),
        // A theme's family is declared only where this realm can measure it,
        // so the SVG names the face its coordinates came from.
        fontAvailable: hasLoadedFace,
        // A viewer has no zoom to gate a miniature by: a referenced canvas
        // draws at the node's intrinsic size, export's policy.
        ...(references === undefined ? {} : { references, expandFileNode: () => true }),
        ...(threads === undefined ? {} : { threads }),
        ...fragments,
        core,
        // No onDegrade: the viewer degrades silently by choice — it has no
        // logger to report through, and a malformed body/unrecognized node
        // still renders (chrome-only or a literal fallback run).
      },
      {
        // `padding` is asked even when the host named none: it is what asks
        // for a whole document — the `width`/`height`/`viewBox` envelope —
        // rather than a fragment whose children keep raw scene coordinates,
        // so a canvas whose nodes start at x=400 would draw as blank space.
        padding: padding ?? 0,
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(background === undefined ? {} : { background }),
      },
    )
    return hostSized ? fillingItsHost(drawn) : drawn
    // fontReady is a pure re-measure trigger, not a value read inside the
    // callback.
  }, [
    canvas,
    resolvedMeasure,
    width,
    height,
    hostSized,
    padding,
    background,
    references,
    fragments,
    core,
    threads,
    style,
    theme,
    fontReady,
  ])

  // Why injecting the string is sound is SceneSvg's doc comment.
  // `figure`, not `img`: the injected SVG's `<text>` runs are real content
  // and today the ONLY way a screen reader reaches any of it, and `img`
  // marks every child presentational — that would buy a name at the cost of
  // the content. A figure names the region and leaves its children
  // reachable. Reading it is still choppy (one run per wrapped line, in
  // document order), which is what the deferred a11y projection is for; a
  // name and reachable text is the honest floor until then.
  return (
    <SceneSvg
      as="figure"
      svg={svg}
      data-testid={testId}
      aria-label={label}
      // A real <figure>, not role="figure" on a div: same semantics, and the
      // element carries them without ARIA. Its UA margin is cleared because
      // this is a layout container the host sizes, not prose.
      style={{
        width: width ?? '100%',
        height: height ?? '100%',
        overflow: 'hidden',
        margin: 0,
      }}
    />
  )
}

/** The root tag's numeric `width` and `height`, which the core writes as the view box's size. */
const ROOT_SIZE = /^(<svg\b[^>]*?)\swidth="[^"]*"\sheight="[^"]*"/

/**
 * The picture sized by the figure rather than by its own extent: the root's
 * `width`/`height` become `100%`, so the SVG fills its host and its view box
 * scales to fit (`xMidYMid meet`, the default). Only the root tag's two size
 * attributes change, the derivation `SceneSvg` names as allowed.
 */
function fillingItsHost(svg: string): string {
  return svg.replace(ROOT_SIZE, '$1 width="100%" height="100%"')
}
