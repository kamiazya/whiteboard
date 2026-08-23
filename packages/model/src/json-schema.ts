import { z } from 'zod'
import { EXTENSION_FACET_KEY_PATTERN } from './facets.js'
import { canvasExtensionSchema, xWhiteboardSchema } from './spatial.js'

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
 */
export function xWhiteboardJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://raw.githubusercontent.com/kamiazya/whiteboard/main/docs/reference/x-whiteboard.schema.json',
    title: 'x-whiteboard JSON Canvas extension',
    description:
      'Definitions for the single extension key ("x-whiteboard") that extended ' +
      'JSON Canvas documents produced by whiteboard may carry, at two sites: ' +
      'the document root (rendering preferences; #/$defs/canvasExtension) and ' +
      'a node (canvas embed; #/$defs/nodeExtension). Documents contain no ' +
      'non-standard fields beyond these two sites. Consumers that drop the ' +
      'key still read a valid JSON Canvas 1.0 document.',
    $defs: {
      canvasExtension: canvasExtensionDef(),
      nodeExtension: toDef(xWhiteboardSchema),
    },
  }
}
