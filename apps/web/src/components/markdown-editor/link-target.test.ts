import { describe, expect, it } from 'vitest'
import {
  externalLinkMarkup,
  type LinkTarget,
  linkMarkupFor,
  rankLinkTargets,
  urlFromQuery,
} from './link-target.js'

const targets: readonly LinkTarget[] = [
  { id: '01JWEEK', path: 'reviews/weekly', name: 'Weekly review', kind: 'markdown' },
  {
    id: '01JWEEK2',
    path: 'reviews/weekly-2026-08',
    name: 'Weekly review 2026-08',
    kind: 'markdown',
  },
  { id: '01JSPRINT', path: 'sprint-board', name: 'Sprint board', kind: 'spatial' },
  { id: '01JDUPE1', path: 'untitled', name: 'untitled', kind: 'markdown' },
  { id: '01JDUPE2', path: 'untitled-2', name: 'untitled', kind: 'markdown' },
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
        { id: 'a', path: 'pa', name: 'my weekly review', kind: 'markdown' },
        { id: 'b', path: 'pb', name: 'Weekly review 2026-08', kind: 'markdown' },
        { id: 'c', path: 'pc', name: 'Weekly review', kind: 'markdown' },
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
  // The PATH is the written form: display names are retired from
  // resolution, and a bare [[path]] is labeled with the target's current
  // display name at render time — so no label is frozen into the body.
  it('writes the bare path when no display text was chosen', () => {
    expect(linkMarkupFor(targets[0] as LinkTarget, targets)).toBe('[[reviews/weekly]]')
  })

  it('carries chosen display text as the alias', () => {
    expect(linkMarkupFor(targets[0] as LinkTarget, targets, 'last week')).toBe(
      '[[reviews/weekly|last week]]',
    )
  })

  // The alias would be noise: it says exactly what the target already says.
  it('omits an alias that matches the path, and blank text', () => {
    expect(linkMarkupFor(targets[0] as LinkTarget, targets, 'reviews/weekly')).toBe(
      '[[reviews/weekly]]',
    )
    expect(linkMarkupFor(targets[0] as LinkTarget, targets, '  ')).toBe('[[reviews/weekly]]')
  })

  it('a shared display name changes nothing — paths are unique', () => {
    expect(linkMarkupFor(targets[3] as LinkTarget, targets)).toBe('[[untitled]]')
    expect(linkMarkupFor(targets[4] as LinkTarget, targets)).toBe('[[untitled-2]]')
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
    expect(linkMarkupFor(targets[0] as LinkTarget, targets, alias)).toBe('[[reviews/weekly]]')
  })

  // `|` is fine there: the scanner is already past the target half.
  it('keeps an alias containing a pipe', () => {
    expect(linkMarkupFor(targets[0] as LinkTarget, targets, 'a|b')).toBe('[[reviews/weekly|a|b]]')
  })

  // A path shaped exactly like a document id: the syntax has no scheme, so
  // that spelling IS the id form and would link somewhere else entirely.
  // The id target is unreadable on its own, so the display name travels as
  // the alias.
  it('falls back to the id, labeled by the name, when the path reads as an id', () => {
    const odd: LinkTarget = {
      id: '01JODD',
      path: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'Shadowy',
      kind: 'markdown',
    }
    expect(linkMarkupFor(odd, [odd])).toBe('[[01JODD|Shadowy]]')
    expect(linkMarkupFor(odd, [odd], 'the odd one')).toBe('[[01JODD|the odd one]]')
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
