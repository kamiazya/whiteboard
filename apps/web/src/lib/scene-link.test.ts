import { describe, expect, it } from 'vitest'
import { sceneLinkTarget } from './scene-link.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function textInAnchor(href: string): Element {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const anchor = document.createElementNS('http://www.w3.org/2000/svg', 'a')
  anchor.setAttribute('href', href)
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
  anchor.append(text)
  svg.append(anchor)
  return text
}

describe('sceneLinkTarget', () => {
  it.each([
    ['a bare document id', ID, ID],
    ['an embed fragment', `#${ID}`, ID],
    ['a relative file', 'guide.md', undefined],
    ['a scheme URL', 'https://example.com/x', undefined],
    ['a root-relative path', '/x', undefined],
    ['a UUID', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', undefined],
  ])('a click inside %s', (_shape, href, expected) => {
    expect(sceneLinkTarget(textInAnchor(href))).toBe(expected)
  })

  it('a click on no link', () => {
    expect(sceneLinkTarget(document.createElementNS('http://www.w3.org/2000/svg', 'text'))).toBe(
      undefined,
    )
    expect(sceneLinkTarget(null)).toBe(undefined)
  })
})
