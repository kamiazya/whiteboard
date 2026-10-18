import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { documentHref, documentIdOfHref, embedHref } from './document-href.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('documentIdOfHref', () => {
  it.each([
    ['a bare document id', ID, ID],
    ['an embed fragment', `#${ID}`, ID],
    ['a relative file', 'guide.md', undefined],
    ['a bare word', 'plan', undefined],
    ['a scheme URL', 'https://example.com/x', undefined],
    ['a root-relative path', '/x', undefined],
    ['a protocol-relative URL', '//example.com/x', undefined],
    ['a UUID', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', undefined],
    ['a lower-cased id', ID.toLowerCase(), undefined],
    ['an id with a path after it', `${ID}/x`, undefined],
    ['a doubled fragment', `##${ID}`, undefined],
    ['an empty href', '', undefined],
    ['no href', null, undefined],
  ])('%s', (_shape, href, expected) => {
    expect(documentIdOfHref(href)).toBe(expected)
  })

  it('decodes what the encoder writes, for a reference and for an embed', () => {
    for (let i = 0; i < 20; i++) {
      const id = generateDocumentId()
      expect(documentIdOfHref(documentHref(id))).toBe(id)
      expect(documentIdOfHref(embedHref(id))).toBe(id)
    }
  })
})

// The resolver behind a wiki link or embed answers a string, and the brand
// is a promise the result needs no sanitising: only the id grammar keeps it.
describe('documentHref and embedHref brand a document id and nothing else', () => {
  it.each([
    ['a script URL', 'javascript:alert(1)'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a scheme URL', 'https://evil.example/x'],
    ['a lower-cased id', ID.toLowerCase()],
    ['an id with a path after it', `${ID}/x`],
    ['an empty string', ''],
  ])('answers # for %s', (_shape, notAnId) => {
    expect(documentHref(notAnId)).toBe('#')
    expect(embedHref(notAnId)).toBe('#')
  })
})
