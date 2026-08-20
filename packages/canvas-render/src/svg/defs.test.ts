import { describe, expect, it } from 'vitest'
import { collectDefs } from './defs.js'
import { el, rawXml, type SvgDef, withDefs } from './vnode.js'

const gradient: SvgDef = { id: 'grad', node: el('linearGradient', { id: 'grad' }) }
const mask: SvgDef = { id: 'mask', node: el('mask', { id: 'mask' }) }

describe('collectDefs', () => {
  it('returns nothing for a tree with no declarations', () => {
    expect(collectDefs([el('g', undefined, [el('rect', { x: 0 }), 'text'])])).toEqual([])
  })

  it('collects a declaration from a deeply nested element', () => {
    const tree = [el('g', undefined, [el('a', { href: '#x' }, [withDefs(el('text'), [gradient])])])]
    expect(collectDefs(tree)).toEqual([gradient])
  })

  it('keeps declaration order and dedupes by id, first occurrence winning', () => {
    const other: SvgDef = { id: 'grad', node: el('linearGradient', { id: 'grad', x1: 1 }) }
    const tree = [
      withDefs(el('text'), [gradient, mask]),
      withDefs(el('text'), [other]), // same id as `gradient` — dropped
    ]
    expect(collectDefs(tree)).toEqual([gradient, mask])
  })

  it('collects each of several distinct ids exactly once', () => {
    const tree = [
      withDefs(el('text'), [gradient]),
      el('g', undefined, [withDefs(el('text'), [mask, gradient])]),
      rawXml('<circle/>'), // opaque: cannot carry declarations
    ]
    expect(collectDefs(tree)).toEqual([gradient, mask])
  })
})
