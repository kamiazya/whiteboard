import type { Scene } from '@kamiazya/whiteboard-scene'
import type { SceneWalkNode } from '../../scene-children.js'

/**
 * The canonical text of a laid-out scene, for a replay that must agree with the
 * TypeScript to the last bit (ADR-0054 decision 11).
 *
 * Every number is written as the hex of its 64 IEEE bits, so `-0` and `0`, and
 * values one ulp apart, are different text. Objects write their keys sorted by
 * UTF-16 code unit and omit an `undefined` field, so the text depends on what a
 * scene says and not on the order a producer built it in. Fields are walked
 * generically, so a field added to the scene vocabulary is dumped without this
 * file knowing it; a new node KIND is what `childFieldsOf` cannot answer, and
 * it fails to compile until it is placed.
 *
 * Test-only: the scene is not a published contract (q53), so nothing here is
 * exported from the package entry.
 */

const bitsView = new DataView(new ArrayBuffer(8))

/** `f64` bits as 16 lowercase hex digits, high word first. */
export function f64Hex(value: number): string {
  bitsView.setFloat64(0, value)
  const word = (offset: number) => bitsView.getUint32(offset).toString(16).padStart(8, '0')
  return word(0) + word(4)
}

function assertNever(value: never): never {
  throw new Error(`scene-dump: unplaced scene node kind ${JSON.stringify(value)}`)
}

/** The fields of a node that hold child nodes, which is how a scene nests. */
function childFieldsOf(node: SceneWalkNode): readonly string[] {
  switch (node.kind) {
    case 'group':
    case 'blockquote':
    case 'embedResolved':
    case 'listItem':
      return ['children']
    case 'list':
      return ['items']
    case 'table':
      return ['rows']
    case 'tableRow':
      return ['cells']
    case 'heading':
    case 'paragraph':
    case 'tableCell':
    case 'codeBlock':
      return ['runs']
    case 'textRun':
    case 'thematicBreak':
    case 'rawHtml':
    case 'unresolvedReference':
    case 'svgFragment':
    case 'embedPlaceholder':
    case 'edge':
    case 'shape':
    case 'image':
    case 'icon':
    case 'glyph':
      return []
    default:
      return assertNever(node)
  }
}

/** How a number is written; the default keeps every bit, a NaN's sign included. */
type NumberText = (value: number) => string

function dumpValue(value: unknown, num: NumberText): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'number':
      return `#${num(value)}`
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object':
      break
    default:
      throw new Error(`scene-dump: a ${typeof value} is not scene data`)
  }
  if (Array.isArray(value)) return `[${value.map((item) => dumpValue(item, num)).join(',')}]`
  return dumpFields(value as Record<string, unknown>, [], () => '', num)
}

function dumpFields(
  fields: Record<string, unknown>,
  nodeFields: readonly string[],
  dumpChild: (child: unknown) => string,
  num: NumberText,
): string {
  const parts = Object.keys(fields)
    .filter((key) => fields[key] !== undefined)
    .sort()
    .map((key) => {
      const value = fields[key]
      const text =
        nodeFields.includes(key) && Array.isArray(value)
          ? `[${value.map(dumpChild).join(',')}]`
          : dumpValue(value, num)
      return `${JSON.stringify(key)}:${text}`
    })
  return `{${parts.join(',')}}`
}

function dumpNode(node: SceneWalkNode, num: NumberText): string {
  return dumpFields(
    node as unknown as Record<string, unknown>,
    childFieldsOf(node),
    (child) => dumpNode(child as SceneWalkNode, num),
    num,
  )
}

/**
 * The canonical text of a scene: its fields sorted like every object's, `nodes` in paint order.
 * `num` writes each number's hex (default `f64Hex`); it is applied to numbers only, so a string
 * that happens to spell a number's text is never rewritten.
 */
export function dumpScene(scene: Scene, num: NumberText = f64Hex): string {
  return dumpFields(
    scene as unknown as Record<string, unknown>,
    ['nodes'],
    (child) => dumpNode(child as SceneWalkNode, num),
    num,
  )
}
