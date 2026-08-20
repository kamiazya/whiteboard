/**
 * The one place an `SvgVNode` tree becomes serialized SVG text. Everything
 * byte-visible is decided here — attribute order (insertion order of the
 * attrs object), number formatting (`formatCoord`), escaping
 * (`escapeXmlAttr`/`escapeXmlText`), self-closing — so the canonical
 * serialization rules live in one function instead of per renderer.
 *
 * The generator is the core and the string API its aggregation: chunk
 * boundaries fall on element opens/closes, which is what a future
 * streaming or per-group patching consumer would consume.
 */

import { escapeXmlAttr, escapeXmlText, formatCoord } from './format.js'
import type { RawXmlChild, SvgChild, SvgVNode } from './vnode.js'

function isRawXml(child: SvgChild): child is RawXmlChild {
  return typeof child === 'object' && child !== null && 'raw' in child
}

function isVNode(child: SvgChild): child is SvgVNode {
  return typeof child === 'object' && child !== null && 'tag' in child
}

function openTag(node: SvgVNode, selfClose: boolean): string {
  let out = `<${node.tag}`
  if (node.attrs !== undefined) {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (value === undefined) continue
      out += ` ${name}="${typeof value === 'number' ? formatCoord(value) : escapeXmlAttr(value)}"`
    }
  }
  return selfClose ? `${out}/>` : `${out}>`
}

function* serializeChildren(children: ReadonlyArray<SvgChild>): Generator<string> {
  for (const child of children) {
    if (typeof child === 'string') {
      yield escapeXmlText(child)
    } else if (Array.isArray(child)) {
      yield* serializeChildren(child)
    } else if (isRawXml(child)) {
      yield child.raw
    } else if (isVNode(child)) {
      yield* serializeSvgChunks(child)
    }
  }
}

export function* serializeSvgChunks(node: SvgVNode): Generator<string> {
  if (node.children === undefined) {
    yield openTag(node, true)
    return
  }
  yield openTag(node, false)
  yield* serializeChildren(node.children)
  yield `</${node.tag}>`
}

/** Serializes any child form — element, text, rawXml, nested arrays — to
 * its exact document bytes; the keyed renderer's per-part serializer. */
export function serializeSvgChild(child: SvgChild): string {
  let out = ''
  for (const chunk of serializeChildren([child])) out += chunk
  return out
}

export function serializeSvg(node: SvgVNode): string {
  let out = ''
  for (const chunk of serializeSvgChunks(node)) out += chunk
  return out
}
