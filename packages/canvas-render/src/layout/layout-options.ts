/**
 * What a spatial layout is ASKED for: every option is data the Rust core's
 * request carries (ADR-0054 step 7), or a listener the host keeps. There is
 * no TypeScript composer left to hand a function seam to (S18h), so the
 * options that were one — the body parser, the math and diagram renderers,
 * the reference resolvers, the tokeniser, the contribution set, the nested
 * layout budget — are gone from the type rather than refused at run time.
 */

import { namespacedIdSchema } from '@kamiazya/whiteboard-facet-engine'
import type { CommentThread, Proposal, SpatialNode } from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { BoundingBox } from '@kamiazya/whiteboard-scene'
import { z } from 'zod'
import type { EdgeAnchorOverride } from '../edge-routing.js'
import type { FragmentAsk, FragmentEntry } from '../fragment-ask.js'
import type { LayoutCore } from '../layout-core.js'
import type { MeasureText } from '../measure.js'
import type { ReferenceSeams } from '../references/seams.js'
import type { LayoutRefusal } from '../refusal.js'
import type { SpatialAppearanceResolver } from '../theme/spatial-appearance.js'
import type { SpatialGeometry } from '../theme/spatial-geometry.js'

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
 * `'clean' | 'document' | <theme id>` — see `SpatialLayoutOptions.style`. A
 * Zod schema because it crosses process boundaries (an MCP tool input, the
 * export routes' bodies); every consumer parses this and infers the type.
 */
export const spatialRenderStyleSchema = z.union([z.enum(['clean', 'document']), namespacedIdSchema])
export type SpatialRenderStyle = z.infer<typeof spatialRenderStyleSchema>

export interface SpatialLayoutOptions {
  readonly measure: MeasureText
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
   * Frozen edge-side choices, threaded to the core's side search: the caller
   * trades crossing optimization for route stability (the live drag
   * overlay pins the committed sides so routes do not flip mid-gesture and
   * pointer frames skip the improvement loop). Absent means sides settle
   * through the full pipeline.
   */
  readonly edgeSideOverrides?: ReadonlyMap<string, EdgeAnchorOverride>
  /**
   * The Rust core (ADR-0054), set by the composition root and read nowhere
   * ambiently: it answers the layout and everything the layout asks. There
   * is nothing to answer in its place.
   */
  readonly core: LayoutCore
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
   * a worker boundary. Absent or empty means
   * nothing is suppressed.
   */
  readonly suppressedBodyNodeIds?: readonly string[]
  /**
   * Nodes the editor holds locked. A lock is editor state, not canvas
   * content (it never reaches a stored canvas, an export or the MCP scene),
   * so the caller says which ids it is and the top-level canvas marks each
   * with a small padlock. Plain data, like `suppressedBodyNodeIds`, so it
   * crosses a worker boundary. Absent or empty draws exactly what an
   * unlocked canvas draws.
   */
  readonly lockedNodeIds?: readonly string[]
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
   * Told when the core REFUSED the layout (owner decision q81, D7): a request
   * past one of its caps, a number its answer cannot spell, or a host
   * measurer that did not answer. The scene answered is then the
   * refusal (`refusalScene`), so a caller that also says why in words (the
   * daemon's log, `wb_scene_render`'s text) learns it here. Omitted, the
   * scene is the same.
   */
  readonly onRefused?: (refusal: LayoutRefusal) => void
  /**
   * The rendered math blocks and diagram fences, by `fragmentAskKey`: what
   * the caller rendered ahead. What the table could not answer is drawn as
   * its fallback (the escaped source, a plain code block) and handed to
   * `onFragmentsAsked`, which a caller answers by rendering those and laying
   * out again.
   */
  readonly fragments?: readonly FragmentEntry[]
  /**
   * The sources a layout asked for that `fragments` could not answer, once
   * each in the order asked; called only when there is one. A listener with
   * no table asks for every source.
   */
  readonly onFragmentsAsked?: (asks: readonly FragmentAsk[]) => void
  /**
   * What the canvas's file nodes and its bodies' links and embeds resolve
   * through, as a bundle rebuilt from a `ReferenceWire` (`referenceWire`):
   * the request carries the wire, so a bundle built any other way is
   * `CoreUnaskable`.
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
   * The caller's expansion policy (the LOD gate): called per file node
   * when a resolution carries a `canvas`; `false` (or an absent callback)
   * keeps the card. canvas-render itself has no expansion policy — the
   * editor decides by on-screen size, export by intrinsic size.
   */
  readonly expandFileNode?: (node: SpatialNode) => boolean
  /**
   * Optional memo for a text node's laid-out body, kept by the core under
   * this object's identity. A body is laid out in origin-relative
   * coordinates, so a kept one is position-independent: keyed by the node's
   * text and box size only. Everything else that shapes content — the
   * measurer, the theme, the references — is NOT in the key: the CALLER owns
   * the cache's lifetime and must drop it when any of those change (in
   * practice one cache per document and theme).
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
   * Whether the annotation layer is drawn at all: pins, cards, leaders,
   * region outlines and passage highlights. Absent/true draws it, which is
   * what every surface a person edits on needs. A caller producing a
   * picture to hand someone else switches it off and gets the board
   * alone.
   */
  readonly commentLayer?: boolean
  /**
   * Extra boxes a comment bubble must not cover, beyond this canvas's own
   * nodes and earlier bubbles. For a caller laying out ONE comment apart
   * from its canvas (the editor's drag preview renders the dragged comment
   * alone) and needing it placed exactly as the committed scene placed it.
   */
  readonly commentObstacles?: readonly BoundingBox[]
  /**
   * This document's annotation layer, handed over beside the canvas: the
   * layer is keeper-side (ADR-0026 decision 1b), stored one level above
   * content, so a canvas never carries it. Every pin and bubble is drawn from
   * these threads (`canvasCommentsOf`, in the order given), and a thread
   * about a PASSAGE of a text node's text (the text arm naming a node, §3)
   * is also drawn as a highlight behind the words it quotes, re-found in the
   * node's laid-out runs by its quote. Absent or empty, nothing is drawn.
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
 * The caller's content cache (`SpatialLayoutOptions.contentCache`): an object
 * the core keys its own laid-out bodies by, for as long as the object lives.
 * Only its identity is read; nothing is stored in it.
 */
export type SpatialContentCache = object
