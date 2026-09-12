import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { EXTENSION_FACET_KEY_PATTERN, endpointNode } from '@kamiazya/whiteboard-model'
import { type CodecParseResult, codecFailure, codecSuccess } from '../errors.js'
import {
  OCIF_TYPE,
  OCIF_VERSION,
  OCIF_WRAPPED_FACET,
  type OcifDocument,
  type OcifExtension,
  type OcifNode,
  type OcifResource,
  ocifDocumentSchema,
} from './ocif.js'

/**
 * A document becomes OCIF in ONE place, the way it becomes JSON Canvas in one
 * place — `OCIF_PROJECTION` is the account of what that costs, and this is
 * what has to agree with it.
 *
 * Built field by field rather than by spread, for the reason `toJsonCanvas`
 * is: a field nobody projected then fails the round-trip property instead of
 * riding along unnoticed.
 *
 * The lift reads OCIF's OWN vocabulary first and this project's extensions
 * only as a refinement. That ordering is not a preference — it is what makes
 * the ledger's `degraded` entries true: a position degraded rather than
 * carried on an extension has to still arrive when the extension is not
 * there, which is exactly what a foreign document is.
 */

const resourceIdFor = (nodeId: string) => `${nodeId}/content`

/** An extension of ours, or nothing when there is nothing to carry. */
function ours(type: string, payload: Record<string, unknown>): OcifExtension | undefined {
  return Object.keys(payload).length === 0 ? undefined : { type, ...payload }
}

/**
 * A facet bucket, as the ordinary OCIF extensions it is: one `data` entry per
 * facet, typed by the facet key.
 *
 * The payload is spread across the entry's own properties, which is how OCIF
 * states an extension's data — except where spreading would lose or collide,
 * and then it is wrapped under the marker `OCIF_WRAPPED_FACET` documents.
 */
function facetEntries(facets: Record<string, unknown> | undefined): OcifExtension[] {
  return Object.entries(facets ?? {}).map(([key, payload]) => {
    const spreadable =
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload) &&
      !('type' in payload)
    return spreadable
      ? { type: key, ...(payload as Record<string, unknown>) }
      : { type: key, [OCIF_WRAPPED_FACET]: true, value: payload }
  })
}

/** The facet bucket an element's `data` array states, or nothing. */
function facetsFrom(
  data: readonly OcifExtension[] | undefined,
): Record<string, unknown> | undefined {
  const entries = (data ?? []).filter((entry) => EXTENSION_FACET_KEY_PATTERN.test(entry.type))
  if (entries.length === 0) return undefined
  return Object.fromEntries(
    entries.map((entry) => {
      if (entry[OCIF_WRAPPED_FACET] === true) return [entry.type, entry.value]
      const { type: _type, ...rest } = entry
      return [entry.type, rest]
    }),
  )
}

/**
 * What a node SHOWS, as an OCIF resource.
 *
 * A node carries at most one `resource` in OCIF, and this model lets a node
 * carry an embed AND its kind's own content. The embed wins — it is what the
 * node displays — and the kind's content then rides an extension of ours,
 * which is the one place this projection is baroque and is so because the
 * model's shape, not OCIF's, makes it possible.
 */
function representationFor(node: SpatialNode): OcifResource['representations'][number] | undefined {
  if (node.embed !== undefined) {
    return {
      location: `wb:document/${node.embed.documentId}`,
      mimeType: 'application/ocif+json',
    }
  }
  switch (node.type) {
    // The body is markdown, which is what the model stores and what OKF reads.
    case 'text':
      return { mimeType: 'text/markdown', content: node.text }
    case 'file':
      return { location: node.file }
    case 'link':
      return { location: node.url, mimeType: 'text/uri-list' }
    case 'group':
      return undefined
  }
}

/** Which nodes a group holds, by this model's rule: geometric containment. */
function membersOf(group: SpatialNode, nodes: readonly SpatialNode[]): string[] {
  return nodes
    .filter(
      (node) =>
        node.id !== group.id &&
        node.x >= group.x &&
        node.y >= group.y &&
        node.x + node.width <= group.x + group.width &&
        node.y + node.height <= group.y + group.height,
    )
    .map((node) => node.id)
}

/**
 * The one node shape whose kind a reader cannot derive from what the node
 * shows: an embed took the resource slot, so the kind's own content — and
 * with it the only native evidence of what the node IS — had to move onto an
 * extension of ours.
 */
const contentIsShadowed = (node: SpatialNode) => node.embed !== undefined && node.type !== 'group'

function projectNode(
  node: SpatialNode,
  nodes: readonly SpatialNode[],
): { node: OcifNode; resource?: OcifResource } {
  const representation = representationFor(node)
  const data: OcifExtension[] = [...facetEntries(node.facets)]

  if (node.type === 'group') {
    data.push({ type: OCIF_TYPE.group, members: membersOf(node, nodes) })
    const chrome = ours(OCIF_TYPE.groupChrome, {
      ...(node.label === undefined ? {} : { label: node.label }),
      ...(node.background === undefined ? {} : { background: node.background }),
      ...(node.backgroundStyle === undefined ? {} : { backgroundStyle: node.backgroundStyle }),
    })
    if (chrome !== undefined) data.push(chrome)
  }
  const shadowed = contentIsShadowed(node)
  const extras = ours(OCIF_TYPE.nodeExtras, {
    ...(node.color === undefined ? {} : { color: node.color }),
    ...(node.type === 'file' && node.subpath !== undefined ? { subpath: node.subpath } : {}),
    ...(node.embed?.versionRef === undefined ? {} : { versionRef: node.embed.versionRef }),
    ...(shadowed && node.type === 'text' ? { text: node.text } : {}),
    ...(shadowed && node.type === 'file' ? { file: node.file } : {}),
    ...(shadowed && node.type === 'link' ? { url: node.url } : {}),
    ...(shadowed ? { kind: node.type } : {}),
  })
  if (extras !== undefined) data.push(extras)

  const projected: OcifNode = {
    id: node.id,
    position: [node.x, node.y],
    size: [node.width, node.height],
    ...(representation === undefined ? {} : { resource: resourceIdFor(node.id) }),
    ...(data.length === 0 ? {} : { data }),
  }
  return representation === undefined
    ? { node: projected }
    : {
        node: projected,
        resource: { id: resourceIdFor(node.id), representations: [representation] },
      }
}

/** The centre of a node's box — what an arrow's end becomes when the model's
 * end is a node and the element has become a drawing rather than a relation. */
const centreOf = (node: SpatialNode) => [node.x + node.width / 2, node.y + node.height / 2]

/**
 * An edge, as the OCIF element it actually is.
 *
 * A relation (both ends on nodes) becomes `@ocif/edge`. Anything with a free
 * end becomes `@ocif/arrow` — a SHAPE — because OCIF edges must run between
 * two node ids. That branch is the conflation ADR-0036 decision 2 splits, and
 * it is visible here as the one place this function has to ask what an edge
 * IS before it can say what it becomes.
 */
function projectEdge(edge: CanvasEdge, nodes: readonly SpatialNode[]): OcifNode {
  const data: OcifExtension[] = [...facetEntries(edge.facets)]
  const fromId = endpointNode(edge.from)
  const toId = endpointNode(edge.to)

  if (fromId !== undefined && toId !== undefined) {
    data.push({
      type: OCIF_TYPE.edge,
      start: fromId,
      end: toId,
      // Per-end markers collapse into one boolean; the ends themselves are
      // carried below so this projection's own round trip keeps them.
      directed: (edge.to.end ?? 'arrow') !== 'none' || (edge.from.end ?? 'none') !== 'none',
    })
  } else {
    const at = (end: CanvasEdge['from']): number[] => {
      if (end.kind === 'point') return [end.point.x, end.point.y]
      const node = nodes.find((n) => n.id === end.node)
      return node === undefined ? [0, 0] : centreOf(node)
    }
    data.push({
      type: OCIF_TYPE.arrow,
      start: at(edge.from),
      end: at(edge.to),
      // The one element shape OCIF gives a per-end marker. Written only where
      // the model states one, so the projection reports the document rather
      // than inventing a default a foreign reader would then read back.
      ...(edge.from.end === undefined ? {} : { startMarker: edge.from.end }),
      ...(edge.to.end === undefined ? {} : { endMarker: edge.to.end }),
    })
  }

  const ends = ours(OCIF_TYPE.edgeEnds, {
    ...(edge.from.kind === 'node' && edge.from.side !== undefined
      ? { fromSide: edge.from.side }
      : {}),
    ...(edge.to.kind === 'node' && edge.to.side !== undefined ? { toSide: edge.to.side } : {}),
    ...(edge.from.end === undefined ? {} : { fromEnd: edge.from.end }),
    ...(edge.to.end === undefined ? {} : { toEnd: edge.to.end }),
    // The endpoint SHAPE, so a free end survives this projection's own round
    // trip even though a foreign reader sees only an arrow.
    fromKind: edge.from.kind,
    toKind: edge.to.kind,
    // The node an end names, carried here as well as on `@ocif/edge`, because
    // an ARROW has no `start`/`end` node ids to read it back from — a line
    // with one free end still attaches to a box at the other, and the round
    // trip lost that box until the property said so.
    ...(edge.from.kind === 'node' ? { fromNode: edge.from.node } : {}),
    ...(edge.to.kind === 'node' ? { toNode: edge.to.node } : {}),
    ...(edge.from.kind === 'point' ? { fromPoint: [edge.from.point.x, edge.from.point.y] } : {}),
    ...(edge.to.kind === 'point' ? { toPoint: [edge.to.point.x, edge.to.point.y] } : {}),
  })
  if (ends !== undefined) data.push(ends)
  if (edge.bends !== undefined) {
    data.push({ type: OCIF_TYPE.bends, points: edge.bends.map((b) => [b.x, b.y]) })
  }
  const rest = ours(OCIF_TYPE.edgeLabel, {
    ...(edge.label === undefined ? {} : { label: edge.label }),
    ...(edge.color === undefined ? {} : { color: edge.color }),
  })
  if (rest !== undefined) data.push(rest)
  return { id: edge.id, data }
}

export function toOcif(canvas: SpatialCanvas): OcifDocument {
  const projected = canvas.nodes.map((node) => projectNode(node, canvas.nodes))
  const resources = projected
    .map((entry) => entry.resource)
    .filter((resource): resource is OcifResource => resource !== undefined)
  const canvasData: OcifExtension[] = [...facetEntries(canvas.facets)]
  if (canvas.comments !== undefined && canvas.comments.length > 0) {
    canvasData.push({ type: OCIF_TYPE.comments, comments: canvas.comments })
  }
  return {
    ocif: OCIF_VERSION,
    nodes: [
      ...projected.map((entry) => entry.node),
      ...canvas.edges.map((edge) => projectEdge(edge, canvas.nodes)),
    ],
    ...(resources.length === 0 ? {} : { resources }),
    ...(canvasData.length === 0 ? {} : { data: canvasData }),
  }
}

/** The extension of a given type on an element, or nothing. */
function extensionOf(
  data: readonly OcifExtension[] | undefined,
  type: string,
): OcifExtension | undefined {
  return data?.find((entry) => entry.type === type)
}

const pair = (value: unknown, fallback: number): [number, number] => {
  const array = Array.isArray(value) ? value : []
  return [
    typeof array[0] === 'number' ? array[0] : fallback,
    typeof array[1] === 'number' ? array[1] : fallback,
  ]
}

const arrowhead = (value: unknown): { end?: 'none' | 'arrow' } =>
  value === 'none' || value === 'arrow' ? { end: value } : {}

/**
 * An endpoint as a FOREIGN reader would recover it — from `@ocif/edge`'s node
 * ids or `@ocif/arrow`'s coordinates, with the arrowhead read off the one
 * boolean OCIF gives a relation.
 *
 * This is what the ledger's `degraded` entries promise, and the only code path
 * that can be compared against them: the faithful path below reads our own
 * extension and would make every entry look native.
 */
function foreignEndpoint(
  which: 'from' | 'to',
  edge: OcifExtension | undefined,
  arrow: OcifExtension | undefined,
): CanvasEdge['from'] {
  const key = which === 'from' ? 'start' : 'end'
  const named = edge?.[key]
  if (typeof named === 'string') {
    // `directed` says the line points at its `end` and says nothing per end,
    // so this is the whole of what OCIF states about a relation's arrowheads.
    const directed = edge?.directed
    const head =
      typeof directed !== 'boolean' ? {} : arrowhead(directed && which === 'to' ? 'arrow' : 'none')
    return { kind: 'node', node: named, ...head }
  }
  const coordinates = arrow?.[key]
  if (Array.isArray(coordinates)) {
    const [x, y] = pair(coordinates, 0)
    return {
      kind: 'point',
      point: { x, y },
      ...arrowhead(arrow?.[which === 'from' ? 'startMarker' : 'endMarker']),
    }
  }
  return { kind: 'node', node: '' }
}

function liftEndpoint(
  which: 'from' | 'to',
  ends: OcifExtension | undefined,
  edge: OcifExtension | undefined,
  arrow: OcifExtension | undefined,
): CanvasEdge['from'] {
  if (ends === undefined) return foreignEndpoint(which, edge, arrow)
  const kind = ends[`${which}Kind`]
  const side = ends[`${which}Side`]
  const end = ends[`${which}End`]
  const tail = {
    ...(typeof side === 'string' ? { side: side as 'top' } : {}),
    ...arrowhead(end),
  }
  if (kind === 'point') {
    const [x, y] = pair(ends[`${which}Point`], 0)
    return { kind: 'point', point: { x, y }, ...arrowhead(end) }
  }
  // `@ocif/edge` states it for a relation; our own extension states it for an
  // arrow, which has nowhere else to put it.
  const named = ends[`${which}Node`] ?? edge?.[which === 'from' ? 'start' : 'end']
  return { kind: 'node', node: typeof named === 'string' ? named : '', ...tail }
}

/**
 * What a node IS, derived from what it shows and what it carries — which is
 * the whole content of `OCIF_PROJECTION`'s claim that the node type degrades
 * rather than disappearing. Our own extension is consulted for exactly the one
 * shape no native signal can distinguish.
 */
function kindOf(
  entry: OcifNode,
  representation: OcifResource['representations'][number] | undefined,
  extras: OcifExtension | undefined,
): SpatialNode['type'] {
  if (extensionOf(entry.data, OCIF_TYPE.group) !== undefined) return 'group'
  const shadowed = extras?.kind
  if (shadowed === 'text' || shadowed === 'file' || shadowed === 'link') return shadowed
  if (representation?.mimeType === 'text/markdown') return 'text'
  if (representation?.mimeType === 'text/uri-list') return 'link'
  if (representation?.location !== undefined) return 'file'
  return 'text'
}

export function fromOcif(ocif: OcifDocument): SpatialCanvas {
  const resources = new Map((ocif.resources ?? []).map((r) => [r.id, r]))
  const nodes: SpatialNode[] = []
  const edges: CanvasEdge[] = []

  for (const entry of ocif.nodes ?? []) {
    const edgeExt = extensionOf(entry.data, OCIF_TYPE.edge)
    const arrowExt = extensionOf(entry.data, OCIF_TYPE.arrow)
    if (edgeExt !== undefined || arrowExt !== undefined) {
      const ends = extensionOf(entry.data, OCIF_TYPE.edgeEnds)
      const rest = extensionOf(entry.data, OCIF_TYPE.edgeLabel)
      const bends = extensionOf(entry.data, OCIF_TYPE.bends)?.points
      const facets = facetsFrom(entry.data)
      edges.push({
        id: entry.id,
        from: liftEndpoint('from', ends, edgeExt, arrowExt),
        to: liftEndpoint('to', ends, edgeExt, arrowExt),
        ...(typeof rest?.color === 'string' ? { color: rest.color } : {}),
        ...(typeof rest?.label === 'string' ? { label: rest.label } : {}),
        ...(Array.isArray(bends)
          ? { bends: bends.map((b) => ({ x: pair(b, 0)[0], y: pair(b, 0)[1] })) }
          : {}),
        ...(facets === undefined ? {} : { facets }),
      } as CanvasEdge)
      continue
    }

    const extras = extensionOf(entry.data, OCIF_TYPE.nodeExtras)
    const chrome = extensionOf(entry.data, OCIF_TYPE.groupChrome)
    const representation =
      entry.resource === undefined ? undefined : resources.get(entry.resource)?.representations[0]
    const [x, y] = pair(entry.position, 0)
    const [width, height] = pair(entry.size, 0)
    const embedded = representation?.mimeType === 'application/ocif+json'
    const facets = facetsFrom(entry.data)
    const shared = {
      id: entry.id,
      x,
      y,
      width,
      height,
      ...(typeof extras?.color === 'string' ? { color: extras.color } : {}),
      ...(facets === undefined ? {} : { facets }),
      ...(embedded
        ? {
            embed: {
              documentId: (representation?.location ?? '').replace('wb:document/', ''),
              ...(typeof extras?.versionRef === 'string' ? { versionRef: extras.versionRef } : {}),
            },
          }
        : {}),
    }
    const kind = kindOf(entry, representation, extras)
    if (kind === 'group') {
      nodes.push({
        ...shared,
        type: 'group',
        ...(typeof chrome?.label === 'string' ? { label: chrome.label } : {}),
        ...(typeof chrome?.background === 'string' ? { background: chrome.background } : {}),
        ...(typeof chrome?.backgroundStyle === 'string'
          ? { backgroundStyle: chrome.backgroundStyle as 'cover' }
          : {}),
      } as SpatialNode)
    } else if (kind === 'file') {
      nodes.push({
        ...shared,
        type: 'file',
        file: (embedded ? extras?.file : representation?.location) as string,
        ...(typeof extras?.subpath === 'string' ? { subpath: extras.subpath } : {}),
      } as SpatialNode)
    } else if (kind === 'link') {
      nodes.push({
        ...shared,
        type: 'link',
        url: (embedded ? extras?.url : representation?.location) as string,
      } as SpatialNode)
    } else {
      nodes.push({
        ...shared,
        type: 'text',
        text: (embedded ? extras?.text : representation?.content) as string,
      } as SpatialNode)
    }
  }

  const canvasFacets = facetsFrom(ocif.data)
  const comments = extensionOf(ocif.data, OCIF_TYPE.comments)?.comments
  return {
    nodes,
    edges,
    ...(canvasFacets === undefined ? {} : { facets: canvasFacets }),
    ...(Array.isArray(comments) ? { comments: comments as SpatialCanvas['comments'] } : {}),
  } as SpatialCanvas
}

/**
 * Read OCIF text as a document — the total parser this package's convention
 * requires (`CodecParseResult`, never a thrown `ZodError`), and the reason
 * `ocifDocumentSchema` exists rather than being a type written beside a cast.
 *
 * Foreign input is where the wire schema's looseness earns its keep: an
 * extension this projection has never heard of survives the parse, reaches
 * `fromOcif`, and is simply not read — which is what OCIF's conformance rules
 * ask of a reader, and the opposite of what the `.strict()` internal model
 * wants of its own writers.
 */
export function parseOcif(text: string): CodecParseResult<SpatialCanvas> {
  let rawValue: unknown
  try {
    rawValue = JSON.parse(text)
  } catch (error) {
    return codecFailure('json-syntax', `malformed OCIF text: ${(error as Error).message}`)
  }
  const parsed = ocifDocumentSchema.safeParse(rawValue)
  if (!parsed.success) {
    return codecFailure('ocif-schema', 'OCIF document failed schema validation', parsed.error)
  }
  return codecSuccess(fromOcif(parsed.data))
}
