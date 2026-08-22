import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { scanReferences } from '@kamiazya/whiteboard-codec'
import { describe, expect, it } from 'vitest'
import type { LinkTarget } from './link-target.js'
import { wikiLinkCompletionSource } from './wiki-link-completion.js'

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const ID_C = '01CX5ZZKBKACTAV9WEVGEMMVRA'
const TARGETS: readonly LinkTarget[] = [
  { id: ID_A, name: 'Release plan' },
  { id: ID_B, name: 'Retro 8月' },
  { id: ID_C, name: 'Dup' },
  { id: '01DX5ZZKBKACTAV9WEVGEMMVRB', name: 'Dup' },
]

function complete(doc: string, pos: number, explicit = false) {
  const state = EditorState.create({ doc })
  const context = new CompletionContext(state, pos, explicit)
  return wikiLinkCompletionSource(() => TARGETS)(context)
}

describe('wikiLinkCompletionSource', () => {
  it('offers ranked candidates inside [[ and inserts the readable markup', () => {
    const doc = '詳細は [[Re'
    const result = complete(doc, doc.length)
    expect(result).not.toBeNull()
    // Replacement starts at the [[, so accepting rewrites the whole reference.
    expect(result?.from).toBe(doc.length - '[[Re'.length)
    const labels = result?.options.map((o) => o.label)
    expect(labels?.[0]).toBe('Release plan')
    expect(labels).toContain('Retro 8月')
    // Load-bearing: the plugin's default filter re-matches labels against
    // the text from `from`, which begins with the [[ no name contains —
    // leaving this true silently discards every result in the real editor.
    expect(result?.filter).toBe(false)

    const state = EditorState.create({ doc })
    const applied = applyOption(state, result!, 0)
    expect(applied).toBe('詳細は [[Release plan]]')
  })

  it('keeps a preceding ! so an embed stays an embed', () => {
    const doc = '![[Re'
    const result = complete(doc, doc.length)
    expect(result?.from).toBe(1) // after the !, at the [[
    const applied = applyOption(EditorState.create({ doc }), result!, 0)
    expect(applied).toBe('![[Release plan]]')
  })

  it('falls back to the id form for a duplicated name', () => {
    const doc = '[[Du'
    const result = complete(doc, doc.length)
    const dup = result?.options.find((o) => o.label === 'Dup')
    expect(dup).toBeDefined()
    const applied = applyOption(EditorState.create({ doc }), result!, result!.options.indexOf(dup!))
    expect(applied).toBe(`[[${ID_C}|Dup]]`)
  })

  it('stays silent outside a [[ context and across a line break', () => {
    expect(complete('plain text', 10)).toBeNull()
    const doc = '[[\nRe'
    expect(complete(doc, doc.length)).toBeNull()
  })

  it('every accepted candidate parses back to exactly one reference to the picked target', () => {
    for (let i = 0; i < TARGETS.length; i++) {
      const result = complete('[[', 2)
      expect(result).not.toBeNull()
      const inserted = applyOption(EditorState.create({ doc: '[[' }), result!, i)
      const refs = scanReferences(inserted)
      expect(refs, inserted).toHaveLength(1)
    }
  })
})

/** Applies option `index` the way CodeMirror would: replace [from, pos) with its apply string. */
function applyOption(
  state: EditorState,
  result: { from: number; options: readonly { apply?: unknown; label: string }[] },
  index: number,
): string {
  const option = result.options[index]
  if (option === undefined) throw new Error(`no option at ${index}`)
  const insert = typeof option.apply === 'string' ? option.apply : option.label
  return state.doc.sliceString(0, result.from) + insert
}
