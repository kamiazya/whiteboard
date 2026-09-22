/**
 * What a spatial layout is ASKED for, and what it resolves that into.
 *
 * `SpatialLayoutOptions` is the public request — every seam a caller
 * supplies. `ResolvedLayoutOptions` is the same thing after the entry point
 * has settled the geometry, the contribution set and its tables, the theme
 * in force and the recursion path, exactly once per call.
 *
 * Their own module so the overlay layers can name them without importing
 * the layout core that BUILDS them. That is the direction the split exists
 * to fix: `comments.ts` and `proposals.ts` depend on the shape of the
 * options, not on the file that assembles them.
 *
 * `RegionChrome` rides along for the same reason. The comment layer
 * produces it and `ResolvedLayoutOptions` names it, so leaving it in
 * `comments.ts` would point the two new modules at each other.
 */

import type { AliasResolver } from '@kamiazya/whiteboard-codec'
import { namespacedIdSchema, type ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type {
  AnchorRect,
  CanvasComment,
  CommentThread,
  Proposal,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { BoundingBox, EdgeRouter, RenderContribution, Scene } from '@kamiazya/whiteboard-scene'
import { z } from 'zod'
import type { MeasureText } from '../measure.js'
import type { ReferenceSeams } from '../references/seams.js'
import type { SpatialGeometry } from '../theme/spatial-geometry.js'
import type { EdgeAnchorOverride } from './edges/spatial-edges.js'
import type { FittedBlocks, MdastLayoutOptions } from './nodes/mdast-blocks.js'
import type { ShapeTable } from './nodes/node-outline.js'
import type { SpatialAppearanceResolver } from './nodes/spatial-appearance.js'
import type { NodePassage } from './passage-highlight.js'

/**
 * A degradation `layoutSpatialCanvas` hit while composing one node, reported
 * only when the caller supplies `onDegrade`. canvas-render itself has no
 * logger (it is a shared layer package with no ambient platform API), so
 * this callback is the observability seam: mcp-server wires it to
 * `getLogger`, canvas-viewer omits it and degrades silently by choice.
 */
export type SpatialLayoutDegradation =
  | { readonly kind: 'body-parse-failed'; readonly nodeId: string; readonly err: unknown }
  /** The canvas (or the `style` override) names a theme no contribution registered; drawn clean. */
  | { readonly kind: 'unknown-theme'; readonly theme: string }
  /** The theme names a font family this surface cannot measure; declared as the bundled one. */
  | { readonly kind: 'font-missing'; readonly family: string }
  | { readonly kind: 'unknown-node-kind'; readonly nodeId: string; readonly type: string }
  // 'repeat' tiling needs the image's intrinsic size, which this pure layer
  // never has (no image decoding behind the resolved `image`) — it
  // renders as 'cover' and the caller is told.
  | {
      readonly kind: 'unsupported-background-style'
      readonly nodeId: string
      readonly style: 'repeat'
    }

/**
 * Presentation-shaped card content for a file node, mapped by the caller
 * from its own facet data (model's `coreFacetsSchema` and friends).
 * Deliberately NOT domain-shaped: this package renders "one bare heading
 * line, then labelled rows" and learns nothing about what a facet MEANS —
 * the semantic mapping (`title = facets.title ?? facets.type`, one row per
 * core facet) is the caller's job. Plain TS, not Zod, per
 * zod-schema-discipline: it is constructed and consumed entirely
 * in-process and never crosses a process boundary.
 */
export interface FacetCardData {
  readonly title?: string
  readonly rows: readonly { readonly label: string; readonly value: string }[]
}

/**
 * `'clean' | 'document' | <theme id>` — see `SpatialLayoutOptions.style`. A
 * Zod schema because it crosses process boundaries (an MCP tool input, the
 * export routes' bodies); every consumer parses this and infers the type.
 */
export const spatialRenderStyleSchema = z.union([z.enum(['clean', 'document']), namespacedIdSchema])
export type SpatialRenderStyle = z.infer<typeof spatialRenderStyleSchema>

export interface SpatialLayoutOptions {
  readonly measure: MeasureText
  /**
   * How a `text` node's body becomes mdast. Defaults to codec's
   * `parseMarkdownBody`, which is what EVERY production caller passed —
   * seven identical lines whose only reason to exist was this package once
   * being forbidden to depend on codec. It stays injectable because layout
   * tests deliberately parse with a stub, the same way they measure with
   * one: a layout assertion should not fail because a markdown parser
   * changed.
   */
  readonly parseBody?: (text: string) => MdastRoot
  readonly appearance: SpatialAppearanceResolver
  /**
   * Geometry constants (padding/label font size/min content width).
   * Defaults to `SPATIAL_THEME_GEOMETRY` — the shared constant every
   * surface must agree on (package-canvas-render.md decision #8). Omit
   * this in every ordinary call site; a caller that must diverge has to
   * pass an explicit override here, never inside `appearance`, so a
   * divergence is a reviewable one-line diff instead of a silent per-file
   * constant.
   */
  readonly geometry?: SpatialGeometry
  /**
   * Frozen edge-side choices, threaded to `assignEdgeAnchors`: the caller
   * trades crossing optimization for route stability (the live drag
   * overlay pins the committed sides so routes do not flip mid-gesture and
   * pointer frames skip the improvement loop). Absent means sides settle
   * through the full pipeline.
   */
  readonly edgeSideOverrides?: ReadonlyMap<string, EdgeAnchorOverride>
  /**
   * Non-rect silhouettes per node id, threaded onto each node's chrome
   * shape and consulted when finishing edge routes (a terminal on the
   * bbox border is pulled onto the outline rim via `outlineEntryPoint`).
   * Plain DATA — a record, never a resolver function — for the same
   * reason as `ResolvedReference`: it must cross `postMessage` so worker
   * layout keeps working when outlines are wired.
   */
  readonly nodeOutlines?: Readonly<Record<string, string>>
  /**
   * Documents already on the embed recursion path when this canvas is
   * itself embedded content — a markdown body's `![[canvas]]`. Seeds the
   * depth cap and the path-local cycle check so they span the
   * markdown/canvas boundary; absent for a top-level canvas.
   */
  readonly embedPath?: readonly string[]
  /**
   * Nodes whose BODY the scene must not draw this pass, because a DOM
   * editor overlay owns their text right now. The chrome — silhouette,
   * stroke, fill, decorations — still draws, which is what lets that
   * overlay be transparent instead of an opaque rectangle covering a
   * non-rectangular node. Plain data (ids, not a predicate) so it crosses
   * a worker boundary the way `nodeOutlines` does. Absent or empty means
   * nothing is suppressed.
   */
  readonly suppressedBodyNodeIds?: readonly string[]
  /**
   * Silhouettes by namespaced id, merged OVER the built-in table — the same
   * shape as `SvgDocumentOptions.icons`. The backend must be handed the same
   * table, or a contributed shape lays out correctly and paints as a rect.
   */
  /**
   * What plugins contribute to rendering: silhouettes, how they read the
   * facets that select them, where they want a node's text, and what they
   * draw on top. Defaults to the bundled `visual` plugin's.
   *
   * A DEFAULT rather than an opt-in, for the lowlight reason: measured, this
   * function has nine call sites and `renderSceneToSvg` nine more, and a
   * resolution step that many have to remember is one a call site forgets —
   * silently drawing a plain node rather than failing.
   *
   * One object rather than an option each: `shapes`, `shapeFacets` and
   * `decorations` accumulated one per increment, none ever had a caller
   * outside this package, and a reader plus text placement would have made
   * five.
   */
  readonly renderContributions?: readonly RenderContribution[]
  /**
   * Which look this render draws (ADR-0030 decision 6). `'clean'` — the
   * DEFAULT — ignores any theme the document carries: an agent reading
   * `wb_scene_render`'s SVG must never pay for jittered geometry or glow it
   * did not ask for (decision #10), so every headless surface gets this by
   * omission and a human surface opts in. `'document'` draws the theme the
   * canvas names (and, in an embed, the host's when the child names none). A
   * theme id draws that theme without saving it — the in-memory session
   * override, and how a person previews a theme before choosing it.
   */
  readonly style?: SpatialRenderStyle
  /**
   * Whether a face for a family exists on THIS surface, so the family a
   * theme names is declared only where it can be measured (font-family.ts:
   * the declared family must be the measured one). Defaults to the bundled
   * family alone; a theme's family that answers false is declared as the
   * bundled one and reported as `font-missing`.
   */
  readonly fontAvailable?: (family: string) => boolean
  readonly onDegrade?: (event: SpatialLayoutDegradation) => void
  /**
   * The mdast CONTENT seams, forwarded verbatim to every `layoutMdastBlocks`
   * call this module makes — a spatial `text` node's body, and a file node's
   * referenced markdown body.
   *
   * Declared here as a passthrough rather than re-specified, because a body
   * is a body: the same document laid out in the markdown editor and inside
   * a canvas node must resolve its math, diagram fences and `![[embed]]`s
   * the same way. Leaving them unforwarded is what made one engine give two
   * answers depending on which surface called it.
   *
   * Absent seams keep `layoutMdastBlocks`'s own documented fallbacks (the
   * escaped-source math placeholder, a plain code block, an
   * `embedPlaceholder`), so an export or viewer that wires none renders
   * exactly as before.
   */
  readonly renderMath?: MdastLayoutOptions['renderMath']
  readonly renderDiagram?: MdastLayoutOptions['renderDiagram']
  readonly resolveEmbed?: MdastLayoutOptions['resolveEmbed']
  readonly resolveTitle?: MdastLayoutOptions['resolveTitle']
  /**
   * Every reference seam at once — `resolveReference` for file nodes and
   * the markdown seams for every body — built by `referenceSeams` from what
   * a keeper loaded. The form a composition root passes; an individual seam
   * set beside it wins, for a caller probing one in isolation.
   */
  readonly references?: ReferenceSeams
  /**
   * The workspace's tag library (ADR-0040 decision 5): a box or an edge
   * carrying a value it colours, and no colour of its own, is drawn in that
   * colour — applied to the CANVAS (`withDeclaredColours`) so the score, the
   * appearance and the legend agree. Absent (a digest), drawn as stored.
   */
  readonly tagLibrary?: TagLibrary
  /**
   * What a text node's `[[target]]` resolves to, applied to its parsed body
   * the way a note's caller applies it before layout. Filled from
   * `references` when absent; an id names itself, and a target nobody
   * resolves stays the literal text the author wrote.
   */
  readonly resolveAlias?: AliasResolver
  /**
   * Tokeniser for fenced code. Defaults to this package's own lowlight-backed
   * implementation, for the same reason `parseBody` defaults to codec's
   * parser: every surface that lays a markdown body out wants it, and the one
   * that forgets it does not fall back to the same picture — it renders code
   * plain while the others colour it.
   *
   * That is not hypothetical. It shipped wired at ONE of the four call sites
   * and left export — the surface the change was for — drawing every fence
   * plain. Supplying it was made an opt-in step, and an opt-in step in four
   * places is a step that gets missed.
   *
   * Still an option, so a caller can substitute a different tokeniser or pass
   * a no-op to render plain. What changed is which way round the default
   * points.
   */
  readonly highlightCode?: MdastLayoutOptions['highlightCode']
  /**
   * Resolves one reference — a file node's `file`, or a group's
   * `background` — to everything the caller knows about it. Absent, or
   * `undefined` for a reference, keeps the plain chrome+label rendering;
   * a throw is caught (total-layout rule) and read as `undefined`.
   *
   * ONE seam rather than one per content kind, because a caller has ONE
   * document per reference: the six callbacks this replaced were six
   * closures over the same lookup, called four times per node for the same
   * key, and every consumer that wired any of them wired most. Collapsing
   * them also makes a resolution plain DATA, which a function seam could
   * never be — the layout worker refuses any canvas whose file seams are
   * wired precisely because a function cannot cross `postMessage`.
   *
   * `expandFileNode` stays separate: it is the caller's POLICY over a node
   * (the editor decides by on-screen size, export by intrinsic size), not
   * something known about the reference. `MdastLayoutOptions.resolveEmbed`
   * likewise stays its own seam — it is keyed by a documentId appearing in
   * prose, not by a spatial node's reference.
   */
  readonly resolveReference?: (ref: string) => ResolvedReference | undefined
  /**
   * The caller's expansion policy (the LOD gate): called per file node
   * when a resolution carries a `canvas`; `false` (or an absent callback)
   * keeps the card. canvas-render itself has no expansion policy — the
   * editor decides by on-screen size, export by intrinsic size.
   */
  readonly expandFileNode?: (node: SpatialNode) => boolean
  /**
   * Optional memo for a text node's laid-out body. Content is laid out in
   * ORIGIN-RELATIVE coordinates and placed by `placeInNode`, so a cached
   * value is position-independent by construction: keyed by the node's
   * text and box size only. Everything else that shapes content —
   * `measure`, the appearance resolver, `geometry`, `parseBody`, the
   * reference and mdast seams — is deliberately NOT in the key: the CALLER owns the cache's
   * lifetime and must discard it when any of those change (in practice:
   * one cache per document+theme, dropped on theme/font switches). Cached
   * values are shared between scenes and must be treated as immutable,
   * which scene nodes already are.
   *
   * Only the success path is cached. The parse-failure fallback recomputes
   * every run so `onDegrade` keeps firing — a cache must change timings,
   * never what the caller is told.
   *
   * Measured before building (the instrument-first rule): content layout
   * is 15-18ms of a 66-125ms full layout on the scene-diff corpus with the
   * arithmetic test measurer — edge routing dominates — so this memo buys
   * roughly the content share, more under a real (Canvas/opentype)
   * measurer whose per-call cost is far above the fake's.
   */
  readonly contentCache?: SpatialContentCache
  /**
   * Draw resolved comments too, muted per the theme's `resolvedOverlay`
   * (ADR-0025 decisions 2 and 5). Absent/false is the historic behavior —
   * resolved comments stay in the document, never composed — so every
   * existing caller's output is byte-identical; the editor's "Show
   * resolved" toggle is per-user LOCAL view state and must never be written
   * to the shared document, only passed here at render time.
   */
  readonly showResolved?: boolean
  /**
   * Extra boxes a comment bubble must not cover, beyond this canvas's own
   * nodes and earlier bubbles. For a caller laying out ONE comment apart
   * from its canvas (the editor's drag preview renders the dragged comment
   * alone) and needing it placed exactly as the committed scene placed it.
   */
  readonly commentObstacles?: readonly BoundingBox[]
  /**
   * This document's annotation layer, handed over beside the canvas rather
   * than read out of its envelope.
   *
   * ADR-0026 decision 1b makes the layer keeper-side: it is stored one level
   * above content, so it no longer rides inside `x-whiteboard`. A markdown
   * document has no envelope at all, which is the argument that decides it —
   * there is nowhere in a canvas key to put a markdown document's comments.
   *
   * When present it REPLACES the envelope's copy rather than adding to it,
   * and an empty array is an answer ("no conversations") rather than a
   * missing one. Both matter while call sites migrate one at a time: the
   * union would draw two pins on one comment, and a fallback would hand a
   * caller that read the layer and found it empty the stale copy back.
   *
   * Absent, the envelope is read as before. That is what keeps every
   * unmigrated caller byte-identical, and it goes once none is left.
   */
  readonly comments?: readonly CanvasComment[]
  /**
   * The document's conversations, for what the flat `comments` cannot
   * carry: a thread about a PASSAGE of a text node's text (the text arm
   * naming a node, ADR-0026 §3) is drawn as a highlight behind the words it
   * quotes, re-found in the node's laid-out runs by its quote. Pins and
   * bubbles still come from `comments` / the envelope — the projection a
   * caller's optimistic state already holds — so a caller passes both.
   * Absent, no passage is highlighted; the pin at the node's corner still
   * says the conversation exists.
   */
  readonly threads?: readonly CommentThread[]
  /**
   * This document's open proposals (ADR-0029), handed over beside the canvas
   * the way the annotation layer is and for the same reason: they are stored
   * one level above content, so there is nowhere in a canvas key to put them.
   *
   * Absent or empty, nothing is drawn — which keeps every existing caller's
   * output byte-identical.
   */
  readonly proposals?: readonly Proposal[]
}

/**
 * The store behind `SpatialLayoutOptions.contentCache`. Deliberately a
 * plain get/set pair rather than a Map subtype, so a caller can wrap an
 * LRU, a WeakRef map, or a plain object without this package caring.
 */
export interface SpatialContentCache {
  get(key: string): FittedBlocks | undefined
  set(key: string, value: FittedBlocks): void
}

/**
 * What a caller knows about one reference. Every field is optional and
 * independent — a caller supplies what it has, and the ranking below
 * decides what gets painted.
 *
 * The content fields are ranked, highest first: `image` (a scaled-down
 * picture is still a meaningful thumbnail, so it is not LOD-gated),
 * `canvas` (inline-embedded, depth-capped at 3 with path-local cycle
 * detection, and gated by `expandFileNode`), `markdown` (the document's own
 * prose, which says more about it than the facets describing it), then
 * `facets`. Anything that produces no usable content — an empty body, a
 * card with no title or rows, a box too small for one block — falls through
 * to the next rank and finally to the plain chrome+label rendering.
 */
export interface ResolvedReference {
  /**
   * Human-readable name, for a caller whose references are opaque ids (the
   * browser-local store). Absent falls back to the raw reference string,
   * which is why an export that resolves nothing keeps labels a pure
   * function of the canvas.
   *
   * A document's name lives in the workspace, not in its content
   * (vocabulary.md) — which is why the markdown body below carries no title
   * of its own, unlike `MdastLayoutOptions.resolveEmbed`, whose embed mixed
   * into prose has no other name source.
   */
  readonly label?: string
  /**
   * The reference points at a target that no longer exists (deleted
   * document, an imported ref into a store that never had it). Renders a
   * quiet "Missing reference" label instead of the raw reference, which for
   * an opaque id tells a reader nothing. This package only paints the
   * state; deciding it is a lookup against the live document list, and so
   * the caller's.
   */
  readonly missing?: boolean
  /** A renderable image: `href` is emitted verbatim into the SVG — a data: URI in exports, a blob:/app URL in the editor. */
  readonly image?: { readonly href: string; readonly alt?: string }
  /** The referenced spatial canvas, for inline embedding. */
  readonly canvas?: SpatialCanvas
  /** A referenced markdown document's already-parsed body. */
  readonly markdown?: MdastRoot
  /** Card content built from the referenced document's facet data. */
  readonly facets?: FacetCardData
}

/** Internal: options with geometry resolved exactly once per layout call. */
export interface ResolvedLayoutOptions extends SpatialLayoutOptions {
  /** `threads`'s node passages, grouped by the node they are about. */
  readonly passagesByNode: ReadonlyMap<string, readonly NodePassage[]>
  /**
   * `threads`'s node sets and regions, by thread id: the box each stands
   * for on THIS canvas (live node bounds, else the stored rect), which is
   * where its outline is drawn and where its pin stands.
   */
  readonly regionsByThread: ReadonlyMap<string, RegionChrome>
  /**
   * How many messages each conversation holds, by thread id — the fact the
   * pin draws. From `threads`, because the flat `comments` projection
   * carries one text and cannot know; absent for a caller that passes none,
   * which then gets the pin it always got.
   */
  readonly messagesByThread: ReadonlyMap<string, number>
  /** The contribution set actually in force, defaulted once at the entry
   *  point so no inner function repeats the `?? [visual]`. */
  readonly contributions: readonly RenderContribution[]
  /** Their shapes, composed to namespaced ids. */
  readonly shapeTable: ShapeTable
  /** Their edge routers, composed to namespaced ids. */
  readonly routerTable: Readonly<Record<string, EdgeRouter>>
  /** Their theme assets, by namespaced id. */
  readonly themeTable: Readonly<Record<string, ThemeTokens>>
  /** The caller's resolver — what a canvas without a theme is painted with. */
  readonly baseAppearance: SpatialAppearanceResolver
  /**
   * The theme in force for the canvas being laid out, resolved by
   * `withCanvasTheme` at every nesting level: an embedded canvas reads its
   * own facet first and inherits this only when it names none.
   */
  readonly activeTheme?: { readonly id: string; readonly tokens: ThemeTokens }
  /**
   * The caller's per-node silhouette overrides, root-keyed by contract, so
   * they apply to the top-level canvas only. `nodeOutlines` is recomputed
   * per canvas from these plus that canvas's facets and the theme default.
   */
  readonly explicitNodeOutlines: Readonly<Record<string, string>> | undefined
  /**
   * How a NESTED canvas is laid out — the composer's own entry point,
   * settled here once rather than imported by the code that needs it.
   *
   * A file embed and a markdown body's `![[canvas]]` both lay out a child
   * canvas from `compose-node.ts`, which `spatial-canvas.ts` imports — so
   * importing the entry back would close a value cycle. Passing it keeps the
   * dependency pointing one way, exactly as `comments.ts` and `proposals.ts`
   * take the body typesetter rather than importing it.
   */
  readonly layoutNestedCanvas: (canvas: SpatialCanvas, options: ResolvedLayoutOptions) => Scene
  /** Document references on the CURRENT recursion path, plus its depth. */
  readonly activeEmbedPath: ReadonlySet<string>
  readonly embedDepth: number
  readonly geometry: SpatialGeometry
  readonly parseBody: (text: string) => MdastRoot
  /**
   * Whether content is trimmed to the node's box. INTERNAL — deliberately
   * not on `SpatialLayoutOptions`, so a normal render can never turn the
   * fit off by accident. `naturalNodeContentSize` is the one caller that
   * clears it, and it is a named function precisely so the intent is
   * legible at the call site instead of being inferred from a degenerate
   * height.
   */
  readonly fitToBox: boolean
}

/** A node set or region thread, with the box it stands for on this canvas. */
export interface RegionChrome {
  readonly rect: AnchorRect
  readonly resolved: boolean
}
