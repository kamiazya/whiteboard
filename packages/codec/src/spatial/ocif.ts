import { z } from 'zod'

/**
 * OCIF v0.7.0 (https://spec.canvasprotocol.org/) as this package writes and
 * reads it — a WIRE shape, declared here for the reason
 * [ADR-0035](../../../../docs/contributing/adr/0035-model-and-format.md) put
 * JSON Canvas here: the model is native, and a format is a projection of it.
 *
 * Declared to the subset this projection uses rather than to the whole
 * specification. What is deliberately absent, so a later reader does not take
 * silence for an oversight: `rotation`/`rotationAxis`/`scale` (the model has
 * no rotation to project), 3D positions, `@ocif/ports`, `@ocif/inherit`,
 * `@ocif/page`, `@ocif/theme-*`, and `@ocif/global-positions`. A document
 * arriving with any of them keeps them — see `extensionSchema` below.
 */

/**
 * Every extension is an object with a `type`, and everything else is the
 * extension's own business. The passthrough is not laziness: OCIF's
 * conformance rules require an implementation to PRESERVE an extension it
 * does not understand, so a schema that stripped unknown keys would make this
 * package non-conforming by construction.
 *
 * This is the opposite of the `.strict()` the internal model uses, and the
 * asymmetry is the same one ADR-0035 recorded for the JSON Canvas wire: a
 * foreign document's vendor keys are legitimate, and the INTERNAL model is
 * where an unknown key is a defect.
 */
const ocifExtensionSchema = z.looseObject({
  type: z.string().min(1),
})
export type OcifExtension = z.infer<typeof ocifExtensionSchema>

/**
 * A representation of a resource: either inline `content` or a `location`,
 * and the spec makes them mutually exclusive. Not modelled as a union here —
 * a foreign document that carries both is malformed rather than
 * unrepresentable, and refusing to READ it would lose the rest of the canvas.
 */
const ocifRepresentationSchema = z.looseObject({
  location: z.string().optional(),
  mimeType: z.string().optional(),
  content: z.string().optional(),
})

const ocifResourceSchema = z.looseObject({
  id: z.string().min(1),
  representations: z.array(ocifRepresentationSchema),
})
export type OcifResource = z.infer<typeof ocifResourceSchema>

/**
 * A node's local geometry. `position` and `size` are arrays because OCIF
 * allows a third axis; this projection writes two and reads the first two,
 * which is the spec's own stated degradation for a 2D tool ("full 3D
 * round-tripping may not be possible").
 */
const ocifNodeSchema = z.looseObject({
  id: z.string().min(1),
  parent: z.string().optional(),
  position: z.array(z.number()).optional(),
  size: z.array(z.number()).optional(),
  resource: z.string().optional(),
  data: z.array(ocifExtensionSchema).optional(),
})
export type OcifNode = z.infer<typeof ocifNodeSchema>

export const ocifDocumentSchema = z.looseObject({
  ocif: z.string().min(1),
  nodes: z.array(ocifNodeSchema).optional(),
  resources: z.array(ocifResourceSchema).optional(),
  data: z.array(ocifExtensionSchema).optional(),
})
export type OcifDocument = z.infer<typeof ocifDocumentSchema>

/** The version URI this projection writes. */
export const OCIF_VERSION = 'https://spec.canvasprotocol.org/v0.7.0/core.json'

/**
 * The extension `type`s this projection reads and writes. The `@ocif/*` names
 * are the specification's; the `@whiteboard/*` names are this project's, and
 * they exist for exactly the positions `OCIF_PROJECTION` marks `extension`.
 */
export const OCIF_TYPE = {
  edge: '@ocif/edge',
  arrow: '@ocif/arrow',
  group: '@ocif/group',
  /** Node chrome OCIF has no vocabulary for: a group's label and background. */
  groupChrome: '@whiteboard/group-chrome',
  /** Which face of a box a line attaches to, and the per-end arrowheads. */
  edgeEnds: '@whiteboard/edge-ends',
  /** The points a person dragged a line through. */
  bends: '@whiteboard/bends',
  /** An edge's on-canvas label, which OCIF models as a separate node. */
  edgeLabel: '@whiteboard/edge-label',
  /** The annotation layer (ADR-0024), canvas-level. */
  comments: '@whiteboard/comments',
  /**
   * What is left of a node once OCIF has taken everything it can state: the
   * preset colour, a file's `subpath`, an embed's `versionRef`, and the
   * kind's own content on the one node shape where an embed took the resource
   * slot away from it.
   *
   * A facet bucket is deliberately NOT here. OCIF's `data[]` is the facet
   * mechanism — a namespaced, typed, schema-declared attribute group — so a
   * facet is written as an ordinary extension of its own, keyed by the facet
   * key. That is what `OCIF_PROJECTION` means when it calls a facet bucket
   * `native`, and carrying one on a vendor key would have made the claim
   * false while every test stayed green.
   */
  nodeExtras: '@whiteboard/node-extras',
} as const

/**
 * Marks a facet entry whose payload could not be spread across the
 * extension's own properties, which is how OCIF states an extension's data.
 *
 * Two cases, both reachable: this model's facet payload is `z.unknown()`, so
 * it need not be an object at all, and an object one may carry a `type` key
 * of its own that would collide with the extension's. Wrapping is the lossless
 * answer to both, and the marker is what lets the lift tell a wrapped payload
 * from a spread one carrying a `value` field.
 */
export const OCIF_WRAPPED_FACET = '@whiteboard/wrapped'
