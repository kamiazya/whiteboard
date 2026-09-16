/**
 * Builders for spatial nodes, for FIXTURES.
 *
 * They exist so a fixture names what a node IS — some text, a file, a URL, a
 * group — instead of spelling the shape the model happens to store it in.
 * That shape is being distilled (ADR-0038 decision 3: text is a resource, not
 * a field on a node kind), and a fixture that spells it has to be rewritten
 * every time it moves. One that names the meaning does not.
 *
 * So the INPUT of each builder is the contract, not its output: the fields
 * below are what a caller means, and a later change to how the model stores
 * them may not add to or rename them. `nodes.test.ts` pins that by
 * constructing each builder's input with no reference to a stored field name.
 */
import type { ExtensionFacets } from '../facets.js'
import { RESOURCE_KINDS } from '../node-resource.js'
import type { CanvasColor, NodeEmbed, SpatialNode } from '../spatial.js'

/** What every node has, whatever it shows. */
interface NodeFields {
  id: string
  x: number
  y: number
  width: number
  height: number
  color?: CanvasColor
  embed?: NodeEmbed
  facets?: ExtensionFacets
}

/**
 * Spread only the optional keys the caller actually supplied. A key holding
 * `undefined` is not the same as an absent key here: the node schemas are
 * `.strict()` and several fixtures assert on the absence of a field, so
 * `{ color: undefined }` would make `toEqual` and `not.toHaveProperty`
 * disagree about the same node.
 */
const present = <T extends object>(fields: T): T =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T

const common = ({ id, x, y, width, height, ...rest }: NodeFields) => ({
  id,
  x,
  y,
  width,
  height,
  ...present(rest),
})

export const textNode = (fields: NodeFields & { text: string }): SpatialNode => {
  const { text, ...node } = fields
  return { ...common(node), resource: { mimeType: RESOURCE_KINDS.text.mimeType, content: text } }
}

export const fileNode = (fields: NodeFields & { file: string; subpath?: string }): SpatialNode => {
  const { file, subpath, ...node } = fields
  return {
    ...common(node),
    resource: {
      // A file's media type is not knowable from a reference alone, and the
      // registry claims any located resource that is not a uri-list, so the
      // generic octet stream is what a fixture means by "a document".
      mimeType: RESOURCE_KINDS.file.mimeType,
      location: file,
      ...present({ subpath }),
    },
  }
}

export const linkNode = (fields: NodeFields & { url: string }): SpatialNode => {
  const { url, ...node } = fields
  return { ...common(node), resource: { mimeType: RESOURCE_KINDS.link.mimeType, location: url } }
}

export const groupNode = (
  fields: NodeFields & {
    label?: string
    background?: string
    backgroundStyle?: 'cover' | 'ratio' | 'repeat'
  },
): SpatialNode => {
  const { label, background, backgroundStyle, ...node } = fields
  // No resource: a frame shows nothing.
  return { ...common(node), ...present({ label, background, backgroundStyle }) }
}
