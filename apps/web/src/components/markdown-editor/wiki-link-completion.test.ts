import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { scanReferences } from '@kamiazya/whiteboard-codec'
import { describe, expect, it } from 'vitest'
import type { LinkTarget } from './link-target.js'
import { wikiLinkCompletionSource } from './wiki-link-completion.js'

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ID_C = '01CX5ZZKBKACTAV9WEVGEMMVRA'
const TARGETS: readonly LinkTarget[] = [
  { id: ID_A, name: 'Release plan' },
  { id: '01BX5ZZKBKACTAV9WEVGEMMVRZ', name: 'Retro 8月' },
  { id: ID_C, name: 'Dup' },
  { id: '01DX5ZZKBKACTAV9WEVGEMMVRB', name: 'Dup' },
]

function complete(doc: string, pos: number) {
  const state = EditorState.create({ doc })
  return wikiLinkCompletionSource(() => TARGETS)(new CompletionContext(state, pos, false))
}

/** Accepts option `index` the way the plugin would: run its apply function. */
function accept(
  doc: string,
  result: NonNullable<ReturnType<ReturnType<typeof wikiLinkCompletionSource>>>,
  index: number,
): string {
  const option = result.options[index]
  if (option === undefined || typeof option.apply !== 'function')
    throw new Error('expected an apply function')
  const view = new EditorView({ state: EditorState.create({ doc }) })
  option.apply(view, option, result.from, doc.length)
  const text = view.state.doc.toString()
  view.destroy()
  return text
}

describe('wikiLinkCompletionSource', () => {
  it('offers ranked candidates AFTER the brackets so the default filter can match, and keeps the result while a plain query grows', () => {
    const doc = '詳細は [[Re'
    const result = complete(doc, doc.length)
    expect(result).not.toBeNull()
    // Load-bearing: `from` at the brackets makes the plugin's label filter
    // score every option zero and silently discard the result; and without
    // validFor every keystroke re-queries, opening the pending window where
    // Enter inserts a newline instead of accepting.
    expect(result?.from).toBe(doc.length - 'Re'.length)
    expect(result?.validFor).toBeDefined()
    expect(result?.options.map((o) => o.label)[0]).toBe('Release plan')
  })

  it('accepting replaces the whole reference, brackets included', () => {
    const doc = '詳細は [[Re'
    const result = complete(doc, doc.length)
    expect(accept(doc, result!, 0)).toBe('詳細は [[Release plan]]')
  })

  it('keeps a preceding ! so an embed stays an embed', () => {
    const doc = '![[Re'
    const result = complete(doc, doc.length)
    expect(accept(doc, result!, 0)).toBe('![[Release plan]]')
  })

  it('falls back to the id form for a duplicated name', () => {
    const doc = '[[Du'
    const result = complete(doc, doc.length)
    const index = result!.options.findIndex((o) => o.label === 'Dup')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(accept(doc, result!, index)).toBe(`[[${ID_C}|Dup]]`)
  })

  it('stays silent outside a [[ context and across a line break', () => {
    expect(complete('plain text', 10)).toBeNull()
    const doc = '[[\nRe'
    expect(complete(doc, doc.length)).toBeNull()
  })

  it('every accepted candidate parses back to exactly one reference', () => {
    for (let i = 0; i < TARGETS.length; i++) {
      const result = complete('[[', 2)
      const inserted = accept('[[', result!, i)
      expect(scanReferences(inserted), inserted).toHaveLength(1)
    }
  })
})
