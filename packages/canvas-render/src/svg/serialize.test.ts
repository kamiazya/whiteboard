import { describe, expect, it } from 'vitest'
import { serializeSvg, serializeSvgChunks } from './serialize.js'
import { el, rawXml } from './vnode.js'

describe('serializeSvg', () => {
  it('emits attributes in insertion order with number values through formatCoord', () => {
    const node = el('rect', { x: 1.5, y: -0, width: 10.125, height: 0 })
    expect(serializeSvg(node)).toBe('<rect x="1.5" y="0" width="10.125" height="0"/>')
  })

  it('omits attributes whose value is undefined (presence-only)', () => {
    const node = el('rect', { x: 0, rx: undefined, fill: undefined })
    expect(serializeSvg(node)).toBe('<rect x="0"/>')
  })

  it('escapes string attribute values including quotes', () => {
    const node = el('a', { href: 'https://e.com/?a=1&b="x"<y>' }, [])
    expect(serializeSvg(node)).toBe(
      '<a href="https://e.com/?a=1&amp;b=&quot;x&quot;&lt;y&gt;"></a>',
    )
  })

  it('escapes plain-string children as text content', () => {
    const node = el('text', { x: 0, y: 0 }, ['a < b & c > d'])
    expect(serializeSvg(node)).toBe('<text x="0" y="0">a &lt; b &amp; c &gt; d</text>')
  })

  it('emits rawXml children verbatim, unescaped', () => {
    const node = el('g', undefined, [rawXml('<circle r="1"/>')])
    expect(serializeSvg(node)).toBe('<g><circle r="1"/></g>')
  })

  it('self-closes when children are absent but pairs tags when children are an empty array', () => {
    expect(serializeSvg(el('g', { role: 'presentation' }))).toBe('<g role="presentation"/>')
    expect(serializeSvg(el('g', undefined, []))).toBe('<g></g>')
    expect(serializeSvg(el('image', { x: 0 }, []))).toBe('<image x="0"></image>')
  })

  it('flattens nested child arrays in document order', () => {
    const node = el('g', undefined, [
      [el('rect', { x: 1 }), [el('rect', { x: 2 })]],
      el('rect', { x: 3 }),
    ])
    expect(serializeSvg(node)).toBe('<g><rect x="1"/><rect x="2"/><rect x="3"/></g>')
  })

  it('recurses into element children', () => {
    const node = el('svg', { xmlns: 'http://www.w3.org/2000/svg' }, [
      el('g', undefined, [el('text', { x: 4, y: 8 }, ['hi'])]),
    ])
    expect(serializeSvg(node)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><g><text x="4" y="8">hi</text></g></svg>',
    )
  })

  it('joins to the same bytes the chunk generator yields', () => {
    const node = el('svg', { xmlns: 'x' }, [el('rect', { x: 1 }), 'txt', rawXml('<g/>')])
    expect([...serializeSvgChunks(node)].join('')).toBe(serializeSvg(node))
  })

  it('throws on a non-finite number attribute (formatCoord contract: a layout bug, not a serializer one)', () => {
    expect(() => serializeSvg(el('rect', { x: Number.NaN }))).toThrow(RangeError)
  })
})
