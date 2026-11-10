import type { Dice } from '../frontmatter-oracle/corpus.js'

/** A JSON token written as the producer spelled it, which `JSON.stringify` could not. */
export class Raw {
  constructor(readonly text: string) {}
}

export type Obj = Record<string, unknown>

export const ULIDS = ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '7ZZZZZZZZZZZZZZZZZZZZZZZZZ', '0'.repeat(26)]
export const BAD_ULIDS = [
  '01arz3ndektsv4rrffq69g5fav',
  '01ARZ3NDEKTSV4RRFFQ69G5FAI',
  '01ARZ3NDEKTSV4RRFFQ69G5FA',
  '01ARZ3NDEKTSV4RRFFQ69G5FAVV',
  '8ZZZZZZZZZZZZZZZZZZZZZZZZZ',
  '01ARZ3NDEKTSV4RRFFQ69G5FAV\n',
  '',
  'x',
]
export const IDS = ['a', 'b', 'c', 'n1', 'node-2', 'x y', 'é', '\u{1f600}', '1', '__proto__', 'ID']
/** Values of the wrong type, or of the right type that no schema accepts. */
export const WRONG: unknown[] = [null, true, false, 0, 1, -1, 1.5, '', 'x', [], [1], {}, { a: 1 }]
export const COLORS = ['1', '2', '3', '4', '5', '6', '#a1B2c3', '#000000', '#FFFFFF']
export const BAD_COLORS: unknown[] = [
  '7',
  '0',
  '#abc',
  '#abcdef0',
  'abc',
  '',
  '#12345g',
  '#abcdef\n',
  ' #abcdef',
  '1 ',
  5,
  1,
  null,
  [],
  {},
  true,
]
export const SIDES = ['top', 'right', 'bottom', 'left']
export const BAD_SIDES: unknown[] = ['Top', '', 'middle', ' top', 5, null, [], {}, true]
export const ENDS = ['none', 'arrow']
export const BAD_ENDS: unknown[] = ['Arrow', '', 'dot', 5, null, [], {}, true]
export const STYLES = ['cover', 'ratio', 'repeat']
export const BAD_STYLES: unknown[] = ['Cover', '', 'stretch', 5, null, []]
export const SUBPATHS = ['#a', '#', '#x y', '##', '#\n']
export const BAD_SUBPATHS: unknown[] = ['a', '', ' #a', '\n#a', 5, null, [], {}]

/** Integers a JSON Canvas coordinate may take. */
export const INTS = [0, 1, -1, 7, 10, 100, -250, 640, 1000, 9007199254740991, -9007199254740991]
/** Numbers that are not integers, or not safe ones, or not numbers JSON spells. */
export const BAD_INTS: unknown[] = [
  1.5,
  -0.5,
  0.1,
  1e-7,
  9007199254740992,
  -9007199254740992,
  1e21,
  1e300,
  -1e300,
  new Raw('1e999'),
  new Raw('-1e999'),
  '1',
  null,
  [],
  {},
  true,
]
/** Integers that JSON spells in a form a plain `JSON.stringify` never writes. */
export const RAW_INTS = [
  new Raw('-0'),
  new Raw('1.0'),
  new Raw('1E2'),
  new Raw('1e2'),
  new Raw('100e-2'),
  new Raw('0.0'),
  new Raw('-0.0'),
  new Raw('5e0'),
  new Raw('1e+2'),
]
export const SIZES = [0, 1, 10, 100, 160, 640, 9007199254740991]
export const BAD_SIZES: unknown[] = [-1, -0.5, 0.5, 1e300, -1e300, new Raw('1e999'), 'x', null, []]
export const FRACTIONS = [0.4, 0.5, 1.5, 2.5, -0.5, -1.5, -0.2, 0.49999999999999994, 1e21, -1e21]

export const FACET_KEYS = ['visual.shape/v0', 'a.b/v12', 'x-y.z9/v1', 'plugin.name/v0']
export const BAD_FACET_KEYS = [
  'plain',
  'Visual.shape/v0',
  'visual.shape',
  'visual.shape/v',
  'a.b/v0\n',
  '1a.b/v0',
  '',
  '2',
]

/**
 * Links as a producer might write one, each an edge of `URL.canParse`. The
 * Rust codec decides the ASCII ones and declines the rest.
 */
export const URLS: string[] = [
  'https://example.com',
  'http://example.com/path?q=1#f',
  'HTTPS://EXAMPLE.COM',
  'https://example.com:8080/x',
  'https://user:pw@example.com',
  'https://user@example.com:80',
  'http://localhost',
  'http://127.0.0.1',
  'http://0x7f.1',
  'http://0x7f000001',
  'http://1.2.3',
  'http://192.168.0.1.',
  'http://256.1.1.1',
  'http://1.2.3.4.5',
  'http://999999999999',
  'http://4294967295',
  'http://4294967296',
  'http://0x',
  'http://0xg',
  'http://09',
  'http://a.09',
  'http://1.2.3.4:65535',
  'http://1.2.3.4:65536',
  'http://a:',
  'http://a:b',
  'http://a:-1',
  'http://a:00080',
  'http://a:99999999999999999999',
  'http://a b.com',
  'http://a<b',
  'http://a>b',
  'http://a^b',
  'http://a|b',
  'http://a_b.com',
  'http://-a.com',
  'http://a..b',
  'http://.',
  'http://..',
  'http://1.2.3.4.',
  'http://0300.0250.0.1',
  'http://0.0.0.0',
  'http://00000000.1',
  'http://%41.com',
  'http://%zz.com',
  'http://é.com',
  'http://xn--nxasmq6b.com',
  'http://XN--a.com',
  'http://[::1]/',
  'http:example.com',
  'http:/example.com',
  'http:\\\\example.com',
  'http:///example.com',
  'http://',
  'http:',
  'http://@',
  'http://user@',
  'http://:80',
  'http://a@b@c',
  'http://a:b@c',
  'http://user:pw@:80',
  'https://example.com/ü',
  'https://example.com/%zz',
  'https://example.com/ a',
  'ftp://a',
  'ws://a',
  'wss://a',
  'file:///x',
  'file:x',
  'foo:bar',
  'foo:',
  'foo://',
  'foo:///x',
  'foo://a b',
  'foo://host:80',
  'foo://host:x',
  'foo://host:99999',
  'foo://:80',
  'foo://user@',
  'foo://user@host',
  'foo://a\\b',
  'foo://a|b',
  'foo://a]b',
  'foo://[::1]',
  'foo:/x',
  'foo:x y',
  'foo://é',
  'mailto:a@b.c',
  'javascript:alert(1)',
  'data:text/plain,hi',
  'a+b-c.d:rest',
  '1abc:rest',
  'a_b:rest',
  'abc',
  'abc:',
  '://x',
  ':x',
  '/relative',
  'relative/path',
  '//host',
  '',
  '   ',
  '\thttps://example.com\n',
  ' https://example.com ',
  '\u0001https://x.com',
  '\u0001 https://x.com\u0001',
  'https://exa\tmple.com',
  'https://exa\nmple.com',
  'https://exa mple.com',
  'https://example.com ',
  ' https://example.com',
  ' https://x.com',
  '﻿https://x.com',
  '​https://x.com',
  'HTTP://A.B',
  'http://A%2eB',
  'https://example.com:443/',
  'http://user:p@ss@host',
  'http://a/b\\c',
  'http://a\\b',
  'http://a?b',
  'http://a#b',
  'http://a:80?b',
  'http://?',
  'http://#',
  'http://\\',
  'http://a\\@b',
  'https://1.2.3.4./',
  'tel:+1-555-0100',
  'urn:isbn:0451450523',
  'about:blank',
  'blob:https://a.com/uuid',
  'http://a\u0000b',
  'http://a\u007fb',
  'http://a\u0001b',
  'http://exa%mple.com',
  'https://日本語.jp',
  'https://example.com/日本語?q=日#日',
]

export const pick = <T>(d: Dice, items: readonly T[]): T => d.pick(items)

/** Render a value as JSON text, spelling a {@link Raw} as written and varying the white space. */
export function render(value: unknown, d: Dice, spaced = d.chance(0.3)): string {
  const ws = (): string => (spaced ? pick(d, [' ', '\n', '\t', '\r\n', '  ']) : '')
  if (value instanceof Raw) return value.text
  if (Array.isArray(value)) {
    return `[${ws()}${value.map((item) => render(item, d, spaced)).join(`,${ws()}`)}${ws()}]`
  }
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value)
      .map(
        (key) => `${JSON.stringify(key)}${ws()}:${ws()}${render((value as Obj)[key], d, spaced)}`,
      )
      .join(`,${ws()}`)
    return `{${ws()}${body}${ws()}}`
  }
  return JSON.stringify(value) ?? 'null'
}
