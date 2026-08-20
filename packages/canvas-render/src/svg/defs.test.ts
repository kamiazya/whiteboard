import { describe, expect, it } from 'vitest'
import { collectDefs } from './defs.js'
import { trustedHref } from './format.js'
import { el, rawXml, type SvgDef, withDefs } from './vnode.js'

const gradient: SvgDef = { id: 'grad', node: el('linearGradient', { id: 'grad' }) }
const mask: SvgDef = { id: 'mask', node: el('mask', { id: 'mask' }) }

describe('collectDefs', () => {
  it('returns nothing for a tree with no declarations', () => {
    const rect = el('rect', { x: 0, y: 0, width: 1, height: 1 })
    expect(collectDefs([el('g', undefined, [rect, 'text'])])).toEqual([])
  })

  it('collects a declaration from a deeply nested element', () => {
    const tree = [
      el('g', undefined, [
        el('a', { href: trustedHref('#x') }, [withDefs(el('text', { x: 0, y: 0 }), [gradient])]),
      ]),
    ]
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

  it('collects a dependency declared on a definition node itself, dependency first', () => {
    // A mask whose gradient dependency rides the mask definition's own node —
    // the natural shape for a def with private dependencies. Dropping it
    // leaves url(#dep-grad) unresolved in the emitted document.
    const depGradient: SvgDef = { id: 'dep-grad', node: el('linearGradient', { id: 'dep-grad' }) }
    const maskWithDep: SvgDef = {
      id: 'dep-mask',
      node: withDefs(el('mask', { id: 'dep-mask' }), [depGradient]),
    }
    const tree = [withDefs(el('text', { x: 0, y: 0 }), [maskWithDep])]
    expect(collectDefs(tree)).toEqual([depGradient, maskWithDep])
  })

  it('terminates on mutually dependent definitions, keeping each once', () => {
    const a: SvgDef = { id: 'a', node: el('mask', { id: 'a' }) }
    const b: SvgDef = { id: 'b', node: withDefs(el('mask', { id: 'b' }), [a]) }
    const aCyclic: SvgDef = { id: 'a', node: withDefs(el('mask', { id: 'a' }), [b]) }
    const tree = [withDefs(el('text', { x: 0, y: 0 }), [aCyclic])]
    const ids = collectDefs(tree).map((def) => def.id)
    expect(ids.sort()).toEqual(['a', 'b'])
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
