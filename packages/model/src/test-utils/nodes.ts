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
import type { CanvasColor, NodeEmbed, SpatialNode } from '../spatial.js'

/**
 * Each builder answers ITS OWN arm, never the whole union. A fixture that
 * wrote `{ ... } as const` had the narrow type, and handing back the union
 * instead breaks the thing fixtures do with a node most often: spreading it
 * and overriding one field. `{ ...node, text: 'edited' }` does not compile
 * against a union whose `file` arm has no `text`, and the error names the
 * spread rather than the builder.
 *
 * These aliases are derived, so ADR-0038 decision 3 redefines them here and
 * the call sites keep compiling.
 */
type Arm<K extends SpatialNode['type']> = Extract<SpatialNode, { type: K }>

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

export const textNode = (fields: NodeFields & { text: string }): Arm<'text'> => {
  const { text, ...node } = fields
  return { ...common(node), type: 'text', text }
}

export const fileNode = (fields: NodeFields & { file: string; subpath?: string }): Arm<'file'> => {
  const { file, subpath, ...node } = fields
  return { ...common(node), type: 'file', file, ...present({ subpath }) }
}

export const linkNode = (fields: NodeFields & { url: string }): Arm<'link'> => {
  const { url, ...node } = fields
  return { ...common(node), type: 'link', url }
}

export const groupNode = (
  fields: NodeFields & {
    label?: string
    background?: string
    backgroundStyle?: 'cover' | 'ratio' | 'repeat'
  },
): Arm<'group'> => {
  const { label, background, backgroundStyle, ...node } = fields
  return { ...common(node), type: 'group', ...present({ label, background, backgroundStyle }) }
}
