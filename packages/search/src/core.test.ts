import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createIndex,
  excerpts,
  findFolded,
  folderNamesOf,
  foldForSearch,
  fullTextSearch,
  installSearchCore,
  isSearchRefusal,
  isSearchUnavailable,
  linkLabels,
  type SearchCore,
  type SearchHit,
  searchableTexts,
  searchCoreInstalled,
  searchIndexCapacity,
  snippetAround,
} from './index.js'
import { tokenize, tokenizeForIndex } from './tokens.js'

// Every function answers through the core a realm installs and through nothing
// else, so the way a realm that forgot to install one fails is the contract.

const calls: { fn: string; args: unknown[] }[] = []
const record =
  <R>(fn: string, answer: R) =>
  (...args: unknown[]): R => {
    calls.push({ fn, args })
    return answer
  }

const labels = { release: () => undefined }
const index = {
  upsert: () => false,
  remove: () => false,
  search: () => [],
  release: () => undefined,
}
const hits: SearchHit[] = [{ documentId: 'a', score: 1, contexts: ['x'] }]
const stub: SearchCore = {
  indexCapacity: 7,
  foldForSearch: record('foldForSearch', 'folded') as SearchCore['foldForSearch'],
  findFolded: record('findFolded', { index: 1, length: 2 }) as SearchCore['findFolded'],
  tokenize: record('tokenize', ['q']) as SearchCore['tokenize'],
  tokenizeForIndex: record('tokenizeForIndex', ['i']) as SearchCore['tokenizeForIndex'],
  folderNamesOf: record('folderNamesOf', ['f']) as SearchCore['folderNamesOf'],
  searchableTexts: record('searchableTexts', ['t']) as SearchCore['searchableTexts'],
  linkLabels: record('linkLabels', labels) as SearchCore['linkLabels'],
  snippetAround: record('snippetAround', 's') as SearchCore['snippetAround'],
  excerpts: record('excerpts', [['e']]) as SearchCore['excerpts'],
  createIndex: record('createIndex', index) as SearchCore['createIndex'],
  fullTextSearch: record('fullTextSearch', hits) as SearchCore['fullTextSearch'],
}

const everyCall: [string, () => unknown][] = [
  ['foldForSearch', () => foldForSearch('a')],
  ['findFolded', () => findFolded('a', 'b')],
  ['tokenize', () => tokenize('a')],
  ['tokenizeForIndex', () => tokenizeForIndex('a')],
  ['folderNamesOf', () => folderNamesOf('a/b', new Map())],
  ['searchableTexts', () => searchableTexts({ kind: 'markdown', body: 'a' })],
  ['linkLabels', () => linkLabels([])],
  ['snippetAround', () => snippetAround('a', 0, 1)],
  ['excerpts', () => excerpts('a', [['b']])],
  ['createIndex', () => createIndex()],
  ['searchIndexCapacity', () => searchIndexCapacity()],
  ['fullTextSearch', () => fullTextSearch([], 'a')],
]

let before: SearchCore | undefined
beforeEach(() => {
  calls.length = 0
})
afterEach(() => {
  installSearchCore(before)
})

describe('a realm with no search core installed', () => {
  beforeEach(() => {
    before = installSearchCore(undefined)
  })

  it('reports no core', () => {
    expect(searchCoreInstalled()).toBe(false)
  })

  it.each(everyCall)('%s throws SearchCoreNotInstalled and answers nothing else', (fn, call) => {
    expect(call).toThrowError(expect.objectContaining({ name: 'SearchCoreNotInstalled' }))
    expect(call).toThrowError(new RegExp(`^${fn} was called before`))
  })
})

describe('a realm that installed a core', () => {
  beforeEach(() => {
    before = installSearchCore(stub)
  })

  it('hands every call to it unchanged and answers what it answers', () => {
    expect(searchCoreInstalled()).toBe(true)
    expect(foldForSearch('Café')).toBe('folded')
    expect(findFolded('abc', 'b')).toEqual({ index: 1, length: 2 })
    expect(tokenize('a b')).toEqual(['q'])
    expect(tokenizeForIndex('a b')).toEqual(['i'])
    expect(folderNamesOf('a/b', new Map([['a', 'A']]))).toEqual(['f'])
    expect(searchableTexts({ kind: 'markdown', body: 'x', description: 'd' })).toEqual(['t'])
    expect(linkLabels([{ documentId: 'a', path: 'p' }])).toBe(labels)
    expect(snippetAround('text', 1, 2, labels)).toBe('s')
    expect(excerpts('q', [['a']], labels)).toEqual([['e']])
    expect(createIndex()).toBe(index)
    expect(searchIndexCapacity()).toBe(7)
    expect(fullTextSearch([], 'q', { limit: 3 })).toBe(hits)
    expect(calls.map((c) => c.fn)).toEqual([
      'foldForSearch',
      'findFolded',
      'tokenize',
      'tokenizeForIndex',
      'folderNamesOf',
      'searchableTexts',
      'linkLabels',
      'snippetAround',
      'excerpts',
      'createIndex',
      'fullTextSearch',
    ])
    expect(calls[7]?.args).toEqual(['text', 1, 2, labels])
    expect(calls[10]?.args).toEqual([[], 'q', { limit: 3 }])
  })

  it('answers the core it replaced, so a stand-in can put the real one back', () => {
    const other: SearchCore = { ...stub, foldForSearch: () => 'other' }
    expect(installSearchCore(other)).toBe(stub)
    expect(foldForSearch('a')).toBe('other')
    expect(installSearchCore(stub)).toBe(other)
  })
})

describe('isSearchUnavailable', () => {
  it('names a refusal and a missing core, and nothing else', () => {
    const refusal = new Error('too large')
    refusal.name = 'CoreInputRefused'
    const before = installSearchCore(undefined)
    const missing = (() => {
      try {
        foldForSearch('a')
      } catch (err) {
        return err
      }
    })()
    installSearchCore(before)
    expect(isSearchUnavailable(refusal)).toBe(true)
    expect(isSearchUnavailable(missing)).toBe(true)
    expect(isSearchUnavailable(new Error('boom'))).toBe(false)
    expect(isSearchRefusal(missing)).toBe(false)
  })
})

describe('isSearchRefusal', () => {
  it('names the core declining an input past a cap, and nothing else', () => {
    const refusal = new Error('too large')
    refusal.name = 'CoreInputRefused'
    expect(isSearchRefusal(refusal)).toBe(true)
    expect(isSearchRefusal(new Error('boom'))).toBe(false)
    expect(isSearchRefusal('CoreInputRefused')).toBe(false)
  })
})
