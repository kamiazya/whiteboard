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

  it('carries a different display text as the alias', () => {
    expect(linkMarkupFor(targets[0] as LinkTarget, targets, 'last week')).toBe(
      '[[Weekly review|last week]]',
    )
  })

  // The alias would be noise: it says exactly what the target already says.
  it('omits an alias that matches the name', () => {
    expect(linkMarkupFor(targets[0] as LinkTarget, targets, 'Weekly review')).toBe(
      '[[Weekly review]]',
    )
    expect(linkMarkupFor(targets[0] as LinkTarget, targets, '  ')).toBe('[[Weekly review]]')
  })

  // The id form is unambiguous but unreadable on its own — the name it came
  // from is exactly what the reader needs, and the codec's alias half is
  // where it goes.
  it('always names the id form, using the display text or the name', () => {
    expect(linkMarkupFor(targets[3] as LinkTarget, targets)).toBe('[[canvas:01JDUPE1|untitled]]')
    expect(linkMarkupFor(targets[3] as LinkTarget, targets, 'the first one')).toBe(
      '[[canvas:01JDUPE1|the first one]]',
    )
  })

  // The codec's scanner stops at the FIRST `]` and matches only if it is
  // doubled, so a single one is as fatal as `]]`: `[[A|Draft] x]]` never
  // resolves at all, and `[[A|note]]]` truncates the alias and leaves a
  // stray `]` in the body.
  it.each([
    ['a ]] b'],
    ['Draft] proposal'],
    ['note]'],
    ['two\nlines'],
  ])('drops an alias the reference scanner cannot read: %s', (alias) => {
    expect(linkMarkupFor(targets[0] as LinkTarget, targets, alias)).toBe('[[Weekly review]]')
  })

  // `|` is fine there: the scanner is already past the target half.
  it('keeps an alias containing a pipe', () => {
    expect(linkMarkupFor(targets[0] as LinkTarget, targets, 'a|b')).toBe('[[Weekly review|a|b]]')
  })

  // The picker knows which one was chosen; the reader of `[[untitled]]`
  // would not, and codec resolves an ambiguous alias to nothing. The name
  // still travels, as the alias.
  it('falls back to the id when two documents share the name', () => {
    expect(linkMarkupFor(targets[3] as LinkTarget, targets)).toBe('[[canvas:01JDUPE1|untitled]]')
  })

  // Every character sequence the codec's own reference parser would read as
  // something other than a plain name: `]]` closes the reference, a newline
  // cannot appear in an inline one, `|` starts the alias half, and a leading
  // `canvas:` is parsed as a direct document id instead of a name.
  it.each([
    ['weird ]] name'],
    ['single ] bracket'],
    ['two\nlines'],
    ['A|B'],
    ['canvas:not-an-id'],
  ])('uses the id when the name cannot be written inside brackets: %s', (name) => {
    const odd: LinkTarget = { id: '01JODD', name, kind: 'markdown' }
    // The name is unwritable as a TARGET, but the alias half is free text up
    // to the closing bracket, so `|` and `canvas:` are fine there.
    const expected = /]|[\r\n]/.test(name) ? '[[canvas:01JODD]]' : `[[canvas:01JODD|${name}]]`
    expect(linkMarkupFor(odd, [odd])).toBe(expected)
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

  // `example.com:` satisfies the URL scheme grammar, so the first parse
  // succeeds with a protocol nobody meant.
  it('promotes a bare host:port too', () => {
    expect(urlFromQuery('example.com:8080/path')).toBe('https://example.com:8080/path')
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

  // A trailing backslash would escape the closing bracket the escape itself
  // adds, so backslashes go first.
  it('escapes a backslash before it can escape our bracket', () => {
    expect(externalLinkMarkup('ends with \\', 'https://example.com')).toBe(
      '[ends with \\\\](https://example.com)',
    )
  })

  // An angle-bracketed destination is closed by the first `>` inside it.
  it('percent-encodes angle brackets in a destination that needs wrapping', () => {
    expect(externalLinkMarkup('docs', 'https://example.com/a(b)>c')).toBe(
      '[docs](<https://example.com/a(b)%3Ec>)',
    )
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
