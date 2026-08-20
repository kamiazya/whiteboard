import { describe, expect, it } from 'vitest'
import { sanitizeHref } from './format.js'
import { el } from './vnode.js'

/**
 * Compile-time contract of the typed element table (elements.ts). The
 * `@ts-expect-error` lines are verified by `tsc --noEmit` (typecheck), not
 * by vitest — an annotation with no error under it FAILS the typecheck, so
 * a loosened element type is caught even though every runtime assertion
 * here stays green.
 */
describe('typed SVG element table', () => {
  it('accepts the shapes the backend actually emits', () => {
    expect(el('rect', { x: 0, y: 0, width: 1, height: 1, rx: 2, fill: '#fff' }).tag).toBe('rect')
    expect(el('text', { x: 0, y: 0, 'xml:space': 'preserve' }, ['hi']).tag).toBe('text')
    expect(el('g', { transform: 'translate(1,0)' }, []).tag).toBe('g')
    expect(el('a', { href: sanitizeHref('https://example.com') }, []).tag).toBe('a')
  })

  it('rejects what the canonical serialization rules forbid', () => {
    // @ts-expect-error unknown element name
    el('rectt', {})
    // @ts-expect-error typo'd attribute name
    el('rect', { x: 0, y: 0, width: 1, heigth: 1 })
    // @ts-expect-error a coordinate must be a number (formatCoord input), not a pre-formatted string
    el('rect', { x: '0', y: 0, width: 1, height: 1 })
    // @ts-expect-error an edge path must declare its fill (SVG's initial black fill must never leak)
    el('polyline', { points: '0,0 1,1' })
    // @ts-expect-error xml:space accepts only the one value the backend uses
    el('text', { x: 0, y: 0, 'xml:space': 'default' })
    // @ts-expect-error an <a href> takes a SafeHref (sanitizeHref/trustedHref), never a raw string
    el('a', { href: 'javascript:alert(1)' }, [])
  })
})
