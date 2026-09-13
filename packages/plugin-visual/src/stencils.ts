/**
 * The stencil ASSETS the bundled plugin ships ([ADR-0034](../../../docs/contributing/adr/0034-stencil-and-recipe.md)),
 * and the one function that applies one to a node.
 *
 * A stencil is a named appearance a drawing applies to ONE box — "a
 * database", "a queue" — so that a vocabulary is authored once rather than
 * invented per board. The measurement that made this worth building is
 * ADR-0033's first reading: across the whole drawing corpus, the hand-drawn
 * references included, every board spends ONE treatment and owes every
 * construct it declares. The channel was not under-used, it was unopened.
 *
 * **Why these six and not more.** ADR-0034's granularity rule: a stencil
 * earns its place when a reader of the finished drawing would name the box
 * as a KIND, and when more than one drawing would use it. These are the
 * nouns an architecture diagram is made of. A larger set is not a better
 * one — ADR-0033's columns charge a treatment that carries no declared
 * distinction as `excess`, so a vocabulary grows when a drawing needs a word
 * it does not have.
 *
 * **No default SIZE, deliberately, in this first increment.** ADR-0034
 * defines a stencil as an appearance plus a default size; the size half is
 * omitted here because it would move `density`, `envelopePx` and the gap
 * columns at the same time as the facet columns, and the first reading of
 * this change is supposed to say whether opening the appearance channel
 * helps. A confounded first reading is worth less than a narrow one. Size
 * lands additively when a stencil needs one (ADR-0013: an optional field
 * needs no version bump).
 *
 * **No emoji badges in the bundled set**, though `visual.symbol` allows
 * them. The PNG export path rasterises through resvg against the vendored
 * Roboto alone (ADR-0011), so an emoji badge exports as tofu — a bundled
 * vocabulary must draw the same everywhere it is drawn. A user-authored
 * library may spend emoji knowing that; this one cannot.
 */
import type { StencilAssetInput } from '@kamiazya/whiteboard-facet-engine'

/**
 * The two keys this set writes, as LITERALS rather than as `data.ts`'s
 * constants: `data.ts` imports this module to register the set, so importing
 * it back would be a value cycle `cycle-check.ts` refuses. `stencils.test.ts`
 * asserts the literals equal the exported constants, so the duplication
 * cannot drift — the same trade `themes.ts` already makes by importing
 * nothing from `data.ts` at all.
 */
const SHAPE_KEY = 'visual.shape/v0'
const SYMBOL_KEY = 'visual.symbol/v0'

/**
 * Keyed by BARE name; the registry composes `visual.<name>`, as it does for
 * themes and icons.
 *
 * **Every member spends SILHOUETTE and nothing else** ([ADR-0036](../../../docs/contributing/adr/0036-semantic-axes.md)
 * §5). A channel carries at most one semantic axis, and the kind axis has
 * one of its own; colour therefore belongs to whatever second axis the
 * drawing declares — healthy-versus-failing on an infrastructure board being
 * the case that named the rule.
 *
 * This used to demand two channels per pair, colour and silhouette, and the
 * reason it did is the reason one is now enough: colour is the channel most
 * often lost (a projector, a colour-blind reader, a greyscale print), so a
 * set leaning on both really leaned on silhouette for any reader who lost
 * it. Spending none does not weaken the vocabulary — it stops pretending,
 * and hands the lost-anyway channel to an axis that can state what it means.
 *
 * The badge is not a channel here either, though two members carry one. This
 * package contributes no node decoration (`render.ts`), so `visual.symbol`
 * draws nothing on a canvas — it reaches the minimap, the favicon and a file
 * row, where a node is too small to read. Counting it once shipped `service`
 * and `external` as two rectangles a reader tells apart by colour alone.
 *
 * Every silhouette distinct puts the set at the CEILING of the silhouette
 * vocabulary: six kinds, six members, and none of them the plain rect an
 * UNDRESSED box already draws. A seventh stencil needs a seventh silhouette,
 * not a seventh entry.
 */
export const VISUAL_STENCILS: Readonly<Record<string, StencilAssetInput>> = {
  /** Anything that holds state and is read back: a database, a bucket, a cache. */
  datastore: {
    displayName: 'Datastore',
    facets: {
      [SHAPE_KEY]: { kind: 'cylinder' },
      [SYMBOL_KEY]: { kind: 'icon', name: 'database' },
    },
  },
  /** Something that runs and answers: an API, a worker, a function. */
  service: {
    displayName: 'Service',
    // The octagon because it is the polygon nearest the rounded rectangle
    // every notation draws a running component as, and `NodeOutline` — a
    // `packages/scene` contract — has no rounded-rect kind. It is also the
    // calmest silhouette available, which suits the box an architecture
    // drawing has most of.
    //
    // This member had none at all until the set stopped spending colour, and
    // that is the order the work had to go in: a stencil with no silhouette
    // and no colour is indistinguishable from an undressed box, which
    // ADR-0033 scores as `deficit` and a reader sees as nothing.
    facets: { [SHAPE_KEY]: { kind: 'octagon' } },
  },
  /** Where traffic enters or is routed: a gateway, a load balancer, a proxy. */
  gateway: {
    displayName: 'Gateway',
    facets: { [SHAPE_KEY]: { kind: 'hexagon' } },
  },
  /** Something in flight rather than at rest: a queue, a topic, a stream. */
  queue: {
    displayName: 'Queue',
    facets: { [SHAPE_KEY]: { kind: 'parallelogram' } },
  },
  /** Whoever the drawing is FOR: a person, a client, a calling system. */
  actor: {
    displayName: 'Actor',
    facets: { [SHAPE_KEY]: { kind: 'ellipse' } },
  },
  /** Something the drawing does not own: a third-party API, a vendor service. */
  external: {
    displayName: 'External',
    // The diamond by elimination — it is the silhouette the other five
    // leave, and the set needs all six distinct. It reads acceptably here
    // because this vocabulary has no decision construct for a flowchart
    // reader to confuse it with: nothing else in an architecture drawing is
    // a diamond, which is what "not ours" wants to say.
    facets: {
      [SHAPE_KEY]: { kind: 'diamond' },
      [SYMBOL_KEY]: { kind: 'icon', name: 'link' },
    },
  },
}
