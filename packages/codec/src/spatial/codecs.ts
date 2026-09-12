import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { CodecParseResult } from '../errors.js'
import type { OcifDocument, OcifExtension } from './ocif.js'
import { OCIF_PROJECTION } from './ocif-projection.js'
import { parseOcif, toOcif } from './ocif-projection-io.js'
import { parseSpatial } from './parse.js'
import type { FieldProjection } from './projection.js'
import { JSON_CANVAS_PROJECTION } from './projection.js'
import { serializeSpatial } from './serialize.js'

/**
 * Every format a spatial document can be written as, in one place.
 *
 * [ADR-0037](../../../../docs/contributing/adr/0037-model-and-format.md) made
 * the model native and JSON Canvas a projection of it;
 * [ADR-0038](../../../../docs/contributing/adr/0038-ocif-projection.md) added
 * a second. With two, "the projection" stopped being a thing and became a
 * KIND of thing — and the guards that were written once per format are the
 * part that does not survive a third being added by someone in a hurry.
 *
 * So this is a registry rather than a list: a codec is the four answers a
 * format owes, and `codecs.property.test.ts` asks all four of every entry.
 * Adding a codec without registering it fails that file's ledger; registering
 * one without a projection table does not typecheck.
 */
export interface SpatialCodec {
  /** Stable id, used in test names and in the ledger below. */
  readonly id: SpatialCodecId
  /** What this format is called in prose. */
  readonly label: string
  /** What projecting each model position onto this format costs. */
  readonly projection: Readonly<Record<string, FieldProjection>>
  /** The document as this format, with everything this project can carry. */
  write(canvas: SpatialCanvas): string
  /** Total, like every parser here: a result, never a thrown `ZodError`. */
  read(text: string): CodecParseResult<SpatialCanvas>
  /**
   * The document as a reader that knows the FORMAT and none of this project's
   * own extensions would receive it.
   *
   * For JSON Canvas this is a real export mode a user can ask for (`strict`).
   * For OCIF there is no such mode and there should not be: conformance
   * requires a reader to preserve an extension it does not understand, so
   * nobody needs a stripped file. It exists here because it is the only thing
   * a `projection` table can be CHECKED against — a ledger nothing compares
   * to behaviour is a claim — and it lives in the registry rather than in a
   * test so that a third format has to answer the same question.
   */
  writeForForeignReader(canvas: SpatialCanvas): string
}

/** Not exported: `SpatialCodec['id']` is how a caller reads one. */
type SpatialCodecId = 'json-canvas' | 'ocif'

/** Drop every `@whiteboard/*` entry, at each of the three sites OCIF has. */
function withoutOurOcifExtensions(ocif: OcifDocument): OcifDocument {
  const keep = (data: readonly OcifExtension[] | undefined) => {
    const kept = (data ?? []).filter((entry) => !entry.type.startsWith('@whiteboard/'))
    return kept.length === 0 ? undefined : kept
  }
  return {
    ...ocif,
    data: keep(ocif.data),
    nodes: (ocif.nodes ?? []).map((node) => ({ ...node, data: keep(node.data) })),
  }
}

export const SPATIAL_CODECS: readonly SpatialCodec[] = [
  {
    id: 'json-canvas',
    label: 'JSON Canvas 1.0',
    projection: JSON_CANVAS_PROJECTION,
    write: (canvas) => serializeSpatial(canvas, 'extended'),
    read: parseSpatial,
    writeForForeignReader: (canvas) => serializeSpatial(canvas, 'strict'),
  },
  {
    id: 'ocif',
    label: 'OCIF v0.7.0',
    projection: OCIF_PROJECTION,
    write: (canvas) => JSON.stringify(toOcif(canvas)),
    read: parseOcif,
    writeForForeignReader: (canvas) => JSON.stringify(withoutOurOcifExtensions(toOcif(canvas))),
  },
]

/** Read back what was just written, or throw naming the codec that refused it. */
function readBack(codec: SpatialCodec, text: string, what: string): SpatialCanvas {
  const parsed = codec.read(text)
  if (!parsed.ok) {
    throw new Error(`${codec.id} could not read its own ${what}: ${parsed.error.message}`)
  }
  return parsed.value
}

/** A document out and back through one format, with nothing stripped. */
export function roundTrip(codec: SpatialCodec, canvas: SpatialCanvas): SpatialCanvas {
  return readBack(codec, codec.write(canvas), 'output')
}

/** The same trip as a reader that understands the format and nothing of ours. */
export function foreignRoundTrip(codec: SpatialCodec, canvas: SpatialCanvas): SpatialCanvas {
  return readBack(codec, codec.writeForForeignReader(canvas), 'stripped output')
}

/**
 * The document every registered codec agrees on: out and back through each of
 * them in turn.
 *
 * This is the set the cross-codec properties are stated over, and it is
 * DERIVED — a third format narrows it the moment it is registered, with
 * nobody editing a list of what the formats have in common. Which is the
 * point: such a list was the alternative, and it would have been written once
 * and then quietly outlived its formats.
 */
export function settle(canvas: SpatialCanvas): SpatialCanvas {
  return SPATIAL_CODECS.reduce((current, codec) => roundTrip(codec, current), canvas)
}
