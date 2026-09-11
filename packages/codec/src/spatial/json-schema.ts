import { EXTENSION_FACET_KEY_PATTERN } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import {
  canvasExtensionSchema,
  facetsOnlyExtensionSchema,
  xWhiteboardSchema,
} from './json-canvas.js'

function toDef(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _root, ...def } = z.toJSONSchema(schema, { target: 'draft-2020-12' })
  return def
}

/**
 * `extensionFacetsSchema` enforces its key grammar in a `superRefine`, which
 * `z.toJSONSchema` cannot translate — emitted as-is the published schema
 * would accept any string key while the code rejects everything outside
 * `{namespace}.{name}/v{n}`. The grammar is injected as `propertyNames` so
 * the artifact keeps its promise of never drifting from what the code
 * accepts.
 */
function canvasExtensionDef(): Record<string, unknown> {
  const def = toDef(canvasExtensionSchema)
  const properties = def.properties as Record<string, Record<string, unknown>> | undefined
  const facets = properties?.facets
  if (facets !== undefined) {
    facets.propertyNames = { type: 'string', pattern: EXTENSION_FACET_KEY_PATTERN.source }
  }
  return def
}

/**
 * The published JSON Schema for the `x-whiteboard` extension — the machine-
 * readable half of the extension contract: a whiteboard document is JSON
 * Canvas 1.0 plus AT MOST this one extension key (canvas-level preferences,
 * node-level embed), and nothing else non-standard is ever emitted.
 *
 * Derived from the Zod schemas so it can never drift from what the code
 * accepts; the committed copy under `docs/reference/` is held equal to this
 * output by a sync test.
 *
 * It lives in the codec because the thing it describes is the WIRE shape
 * ([ADR-0033](../../../../docs/contributing/adr/0033-model-and-format.md)).
 * It was generated from the model until the model stopped being the format.
 */
export function xWhiteboardJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://raw.githubusercontent.com/kamiazya/whiteboard/main/docs/reference/x-whiteboard.schema.json',
    title: 'x-whiteboard JSON Canvas extension',
    description:
      'Definitions for the single extension key ("x-whiteboard") that extended ' +
      'JSON Canvas documents produced by whiteboard may carry, at three sites: ' +
      'the document root (canvas facets and comments; #/$defs/canvasExtension), ' +
      'a node (canvas embed and node facets; #/$defs/nodeExtension) and an edge ' +
      '(edge facets; #/$defs/edgeExtension). Documents contain no non-standard ' +
      'fields beyond these three sites. Consumers that drop the key still read ' +
      'a valid JSON Canvas 1.0 document.',
    $defs: {
      canvasExtension: canvasExtensionDef(),
      nodeExtension: toDef(xWhiteboardSchema),
      edgeExtension: toDef(facetsOnlyExtensionSchema),
    },
  }
}
