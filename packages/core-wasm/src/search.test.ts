import { describe, expect, it } from 'vitest'
import type { Finalizer } from './font-handles.js'
import { SEARCH_OP_CAPS } from './generated/input-caps.js'
import { CoreInputRefused } from './index.js'
import { type SearchGlue, searchOver } from './search.js'

const errors = {
  refused: (operation: string, code: 'input-too-large' | 'malformed', detail?: string) =>
    new CoreInputRefused(operation, code, detail),
}

function fake(answers: string[]) {
  const sent: unknown[][] = []
  const glue: SearchGlue = {
    search_op: (request) => {
      sent.push(JSON.parse(request) as unknown[])
      return answers.shift() ?? '["refused","malformed"]'
    },
  }
  return { glue, sent }
}

function finalizer() {
  const registered: { handle: number; token: object }[] = []
  const unregistered: object[] = []
  let release: (handle: number) => void = () => undefined
  const make = (onCollected: (handle: number) => void): Finalizer => {
    release = onCollected
    return {
      register: (_target, handle, token) => registered.push({ handle, token }),
      unregister: (token) => unregistered.push(token),
    }
  }
  return { make, registered, unregistered, collect: (handle: number) => release(handle) }
}

describe('the search shim over a fake glue', () => {
  it('sends one op per call, as [op, ...args], and reads what follows ok', () => {
    const { glue, sent } = fake(['["ok","cafe"]', '["ok",[3,2]]', '["ok",null]'])
    const search = searchOver(glue, errors)
    expect(search.foldForSearch('Café')).toBe('cafe')
    expect(search.findFolded('abcde', 'de')).toEqual({ index: 3, length: 2 })
    expect(search.findFolded('abcde', 'zz')).toBeUndefined()
    expect(sent).toEqual([
      ['fold', 'Café'],
      ['find', 'abcde', 'de'],
      ['find', 'abcde', 'zz'],
    ])
  })

  it('maps the artifact refusals to CoreInputRefused with their code and the op', () => {
    const { glue } = fake(['["refused","input-too-large"]', '["refused","malformed"]', 'null'])
    const search = searchOver(glue, errors)
    expect(() => search.foldForSearch('a')).toThrowError(
      expect.objectContaining({ operation: 'search_op', code: 'input-too-large', detail: 'fold' }),
    )
    expect(() => search.foldForSearch('a')).toThrowError(
      expect.objectContaining({ code: 'malformed' }),
    )
    expect(() => search.foldForSearch('a')).toThrowError(
      expect.objectContaining({ code: 'malformed' }),
    )
  })

  it('refuses an answer of the wrong shape as malformed', () => {
    const { glue } = fake(['["ok",7]', '["ok",["x"]]', '["ok",[1]]', '["ok",[3]]'])
    const search = searchOver(glue, errors)
    expect(() => search.foldForSearch('a')).toThrowError(
      expect.objectContaining({ code: 'malformed' }),
    )
    expect(() => search.tokenize('a')).toThrowError(expect.objectContaining({ code: 'malformed' }))
    expect(() => search.findFolded('a', 'a')).toThrowError(
      expect.objectContaining({ code: 'malformed' }),
    )
  })

  it('refuses a request past the entry without calling the artifact', () => {
    const { glue, sent } = fake([])
    const search = searchOver(glue, errors)
    expect(() => search.foldForSearch('x'.repeat(8 * 1024 * 1024))).toThrowError(
      expect.objectContaining({ code: 'input-too-large' }),
    )
    expect(sent).toEqual([])
  })

  it('refuses by the UTF-8 bytes a request is sent as, not its UTF-16 length', () => {
    // '["fold",""]' is 11 bytes, and each 界 three.
    const fits = Math.floor((SEARCH_OP_CAPS.maxBytes - 11) / 3)
    const { glue, sent } = fake(['["ok","x"]'])
    const search = searchOver(glue, errors)
    expect(() => search.foldForSearch('界'.repeat(fits + 1))).toThrowError(
      expect.objectContaining({ code: 'input-too-large' }),
    )
    expect(sent).toEqual([])
    expect(search.foldForSearch('界'.repeat(fits))).toBe('x')
    expect(sent).toHaveLength(1)
  })

  it('counts a surrogate pair as four bytes and a lone surrogate as the three of U+FFFD', () => {
    const pairs = Math.floor((SEARCH_OP_CAPS.maxBytes - 11) / 4)
    const { glue, sent } = fake(['["ok","x"]', '["ok","x"]'])
    const search = searchOver(glue, errors)
    expect(search.foldForSearch('😀'.repeat(pairs))).toBe('x')
    expect(() => search.foldForSearch('😀'.repeat(pairs + 1))).toThrowError(
      expect.objectContaining({ code: 'input-too-large' }),
    )
    const lone = Math.floor((SEARCH_OP_CAPS.maxBytes - 11) / 3)
    expect(search.foldForSearch('\uD800'.repeat(lone))).toBe('x')
    expect(sent).toHaveLength(2)
  })

  it('refuses an answer that is not JSON as malformed', () => {
    const { glue } = fake(['not json'])
    expect(() => searchOver(glue, errors).foldForSearch('a')).toThrowError(
      expect.objectContaining({ operation: 'search_op', code: 'malformed', detail: 'fold' }),
    )
  })

  it('refuses a document id that is not well-formed instead of keying it as another', () => {
    const { glue, sent } = fake(['["ok",0]'])
    const index = searchOver(glue, errors).createIndex()
    const ill = { documentId: 'a\uD800', path: 'p', texts: [] }
    expect(() => index.upsert(ill)).toThrowError(expect.objectContaining({ code: 'malformed' }))
    expect(() => index.remove('a\uD801')).toThrowError(
      expect.objectContaining({ code: 'malformed' }),
    )
    expect(sent).toEqual([['index-new']])
  })

  it('refuses a label set another instance minted, and shares one between facades of one', () => {
    const one = fake(['["ok",0]', '["ok","seen"]'])
    const other = fake([])
    const labels = searchOver(one.glue, errors).linkLabels([{ documentId: 'd', path: 'p' }])
    expect(() => searchOver(other.glue, errors).snippetAround('t', 0, 1, labels)).toThrowError(
      expect.objectContaining({ code: 'malformed', detail: 'snippet' }),
    )
    expect(() => searchOver(other.glue, errors).excerpts('q', [['t']], labels)).toThrowError(
      expect.objectContaining({ code: 'malformed', detail: 'excerpts' }),
    )
    expect(other.sent).toEqual([])
    expect(searchOver(one.glue, errors).snippetAround('t', 0, 1, labels)).toBe('seen')
  })

  it('asks for each document alone when a page of them is past the cap, so none loses its excerpts', () => {
    const { glue, sent } = fake([
      '["refused","input-too-large"]',
      '["ok",[["one"]]]',
      '["refused","input-too-large"]',
      '["ok",[["three"]]]',
    ])
    const answered = searchOver(glue, errors).excerpts('q', [['a'], ['b'], ['c']])
    expect(answered).toEqual([['one'], [], ['three']])
    expect(sent.map((request) => request[3])).toEqual([
      [['a'], ['b'], ['c']],
      [['a']],
      [['b']],
      [['c']],
    ])
  })

  it('does not retry an excerpt refusal that is not about size', () => {
    const { glue, sent } = fake(['["refused","malformed"]'])
    expect(() => searchOver(glue, errors).excerpts('q', [['a'], ['b']])).toThrowError(
      expect.objectContaining({ code: 'malformed', detail: 'excerpts' }),
    )
    expect(sent).toHaveLength(1)
  })

  it('sends a lone surrogate as the replacement character', () => {
    const { glue, sent } = fake(['["ok","x"]'])
    searchOver(glue, errors).foldForSearch('a\uD800b')
    expect(sent).toEqual([['fold', 'a�b']])
  })

  it('expands every text, the path and the name for an index, never the folder names', () => {
    const { glue, sent } = fake(['["ok",0]', '["ok",false]'])
    const search = searchOver(glue, errors)
    const index = search.createIndex()
    index.upsert(
      { documentId: 'd', path: 'p', name: 'n', texts: ['t', 'u'], folders: ['f'] },
      (text) => (text === 't' ? 'extra' : ''),
    )
    expect(sent[1]).toEqual(['index-upsert', 0, 'd', 'p', 'n', ['t extra', 'u'], ['f']])
    index.release()
  })

  it('sends no name as the empty text and no folders as null', () => {
    const { glue, sent } = fake(['["ok",0]', '["ok",false]'])
    const index = searchOver(glue, errors).createIndex()
    index.upsert({ documentId: 'd', path: 'p', texts: [] })
    expect(sent[1]).toEqual(['index-upsert', 0, 'd', 'p', '', [], null])
  })

  it('decodes hits as their ids and the doubles their bits spell', () => {
    const { glue, sent } = fake([
      '["ok",1]',
      '["ok",[["a","3ff0000000000000"],["b","bff8000000000000"]]]',
    ])
    const index = searchOver(glue, errors).createIndex()
    expect(index.search('q', 5)).toEqual([
      { documentId: 'a', score: 1 },
      { documentId: 'b', score: -1.5 },
    ])
    expect(sent[1]).toEqual(['index-query', 1, 'q', 5])
  })

  it('refuses hits whose score is not sixteen hex digits', () => {
    const { glue } = fake(['["ok",1]', '["ok",[["a","3ff"]]]'])
    const index = searchOver(glue, errors).createIndex()
    expect(() => index.search('q')).toThrowError(expect.objectContaining({ code: 'malformed' }))
  })

  it('releases a handle once, on release or on collection, never twice', () => {
    const { glue, sent } = fake(['["ok",4]', '["ok",true]', '["ok",true]'])
    const memo = finalizer()
    const search = searchOver(glue, errors, memo.make)
    const index = search.createIndex()
    expect(memo.registered.map((entry) => entry.handle)).toEqual([4])
    index.release()
    index.release()
    expect(sent).toEqual([['index-new'], ['index-release', 4]])
    expect(memo.unregistered).toHaveLength(1)
  })

  it('releases what a collected handle names, and a refusal there is not thrown', () => {
    const { glue, sent } = fake(['["refused","malformed"]'])
    const memo = finalizer()
    searchOver(glue, errors, memo.make)
    expect(() => memo.collect(9)).not.toThrow()
    expect(sent).toEqual([['index-release', 9]])
  })
})
