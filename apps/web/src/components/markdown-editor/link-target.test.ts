import { describe, expect, it } from 'vitest'
import {
  externalLinkMarkup,
  type LinkTarget,
  linkMarkupFor,
  rankLinkTargets,
  urlFromQuery,
} from './link-target.js'

const targets: readonly LinkTarget[] = [
  { id: '01JWEEK', name: 'Weekly review', kind: 'markdown' },
  { id: '01JWEEK2', name: 'Weekly review 2026-08', kind: 'markdown' },
  { id: '01JSPRINT', name: 'Sprint board', kind: 'spatial' },
  { id: '01JDUPE1', name: 'untitled', kind: 'markdown' },
  { id: '01JDUPE2', name: 'untitled', kind: 'markdown' },
]

describe('rankLinkTargets', () => {
  it('returns every target for an empty query', () => {
    expect(rankLinkTargets(targets, '').map((t) => t.id)).toEqual(targets.map((t) => t.id))
  })

  it('matches on any part of the name, case-insensitively', () => {
    expect(rankLinkTargets(targets, 'sprint').map((t) => t.name)).toEqual(['Sprint board'])
    expect(rankLinkTargets(targets, 'BOARD').map((t) => t.name)).toEqual(['Sprint board'])
  })

  // Typing more should narrow toward what you meant, so an exact name and a
  // prefix both outrank a match buried mid-name.
  it('ranks exact name, then prefix, then contained', () => {
    const ranked = rankLinkTargets(
      [
        { id: 'a', name: 'my weekly review', kind: 'markdown' },
        { id: 'b', name: 'Weekly review 2026-08', kind: 'markdown' },
        { id: 'c', name: 'Weekly review', kind: 'markdown' },
      ],
      'weekly review',
    )
    expect(ranked.map((t) => t.id)).toEqual(['c', 'b', 'a'])
  })

  it('drops targets that do not match at all', () => {
    expect(rankLinkTargets(targets, 'zzz')).toEqual([])
  })
})

describe('linkMarkupFor', () => {
  it('writes the display name when it is unambiguous', () => {
    expect(linkMarkupFor(targets[0] as LinkTarget, targets)).toBe('[[Weekly review]]')
  })

  // The picker knows which one was chosen; the reader of `[[untitled]]`
  // would not, and codec resolves an ambiguous alias to nothing.
  it('falls back to the id when two documents share the name', () => {
    expect(linkMarkupFor(targets[3] as LinkTarget, targets)).toBe('[[canvas:01JDUPE1]]')
  })

  // `]]` inside a name would close the reference early, and a newline
  // cannot survive an inline reference at all.
  it('uses the id when the name cannot be written inside brackets', () => {
    const odd: LinkTarget = { id: '01JODD', name: 'weird ]] name', kind: 'markdown' }
    expect(linkMarkupFor(odd, [odd])).toBe('[[canvas:01JODD]]')
  })
})

describe('urlFromQuery', () => {
  it('recognises an http(s) URL', () => {
    expect(urlFromQuery('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(urlFromQuery('  http://example.com  ')).toBe('http://example.com')
  })

  it('promotes a bare domain to https', () => {
    expect(urlFromQuery('example.com/docs')).toBe('https://example.com/docs')
  })

  it('is not fooled by ordinary prose or a document name', () => {
    expect(urlFromQuery('Weekly review')).toBeNull()
    expect(urlFromQuery('')).toBeNull()
    expect(urlFromQuery('notes about node.js')).toBeNull()
  })

  // A scheme we do not want to write into a document from a search box.
  it('refuses non-http schemes', () => {
    expect(urlFromQuery('javascript:alert(1)')).toBeNull()
    expect(urlFromQuery('file:///etc/passwd')).toBeNull()
  })
})

describe('externalLinkMarkup', () => {
  it('keeps the text that was there as the link text', () => {
    expect(externalLinkMarkup('the docs', 'https://example.com')).toBe(
      '[the docs](https://example.com)',
    )
  })

  it('writes a bare autolink when there is no text to carry it', () => {
    expect(externalLinkMarkup('', 'https://example.com')).toBe('<https://example.com>')
    expect(externalLinkMarkup('   ', 'https://example.com')).toBe('<https://example.com>')
  })

  // A `]` in the text would close the label early and leave the rest as prose.
  it('escapes brackets in the link text', () => {
    expect(externalLinkMarkup('a [b] c', 'https://example.com')).toBe(
      '[a \\[b\\] c](https://example.com)',
    )
  })

  // Spaces and parens in a URL break the inline form; angle brackets are the
  // CommonMark answer for exactly that.
  it('wraps a destination that needs it in angle brackets', () => {
    expect(externalLinkMarkup('docs', 'https://example.com/a(b)')).toBe(
      '[docs](<https://example.com/a(b)>)',
    )
  })
})
