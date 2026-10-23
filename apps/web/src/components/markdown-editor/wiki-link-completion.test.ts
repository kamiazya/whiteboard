import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { scanReferences } from '@kamiazya/whiteboard-codec'
import { describe, expect, it } from 'vitest'
import type { LinkTarget } from '../../lib/link-target.js'
import { wikiLinkCompletionSource } from './wiki-link-completion.js'

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ID_C = '01CX5ZZKBKACTAV9WEVGEMMVRA'
const TARGETS: readonly LinkTarget[] = [
  { id: ID_A, path: 'release-plan', name: 'Release plan' },
  { id: '01BX5ZZKBKACTAV9WEVGEMMVRZ', path: 'retro-08', name: 'Retro 8月' },
  { id: ID_C, path: 'dup', name: 'Dup' },
  { id: '01EX5ZZKBKACTAV9WEVGEMMVRC', path: 'same', name: 'same' },
  { id: '01DX5ZZKBKACTAV9WEVGEMMVRB', path: 'dup-2', name: 'Dup' },
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
    // Resolution stays by PATH; the alias makes the source read as the name.
    expect(accept(doc, result!, 0)).toBe('詳細は [[release-plan|Release plan]]')
  })

  it('keeps a preceding ! so an embed stays an embed', () => {
    const doc = '![[Re'
    const result = complete(doc, doc.length)
    expect(accept(doc, result!, 0)).toBe('![[release-plan|Release plan]]')
  })

  it('a duplicated name is no problem — paths are unique', () => {
    const doc = '[[Du'
    const result = complete(doc, doc.length)
    const index = result!.options.findIndex((o) => o.label === 'Dup')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(accept(doc, result!, index)).toBe('[[dup|Dup]]')
  })

  it("tells two same-named documents apart by showing each one's path beside the name", () => {
    const doc = '[[Du'
    const result = complete(doc, doc.length)
    const dups = result!.options.filter((o) => o.label === 'Dup')
    expect(dups.map((o) => o.detail).sort()).toEqual(['dup', 'dup-2'])
  })

  it('inserts at the CURRENT bracket position even after the document changed above it', () => {
    // The mobile desync shape: the result opens, then the document shifts
    // under it before the user accepts — an autocorrect elsewhere, a CRDT
    // remote echo, another tab. CodeMirror maps the from/to it hands to
    // apply through those changes; an offset captured when the source RAN
    // does not move with them, and the markup lands mid-word at the stale
    // position, silently corrupting the body.
    const before = '詳細は [[Re'
    const result = complete(before, before.length)
    expect(result).not.toBeNull()
    const option = result?.options[0]
    if (option === undefined || typeof option.apply !== 'function')
      throw new Error('expected apply fn')

    const view = new EditorView({ state: EditorState.create({ doc: before }) })
    const PREFIX = '先頭に挿入された行。\n'
    view.dispatch({ changes: { from: 0, to: 0, insert: PREFIX } })
    // What the plugin would pass: the ORIGINAL positions mapped through the
    // concurrent change.
    const mappedFrom = PREFIX.length + before.length - 'Re'.length
    const mappedTo = PREFIX.length + before.length
    option.apply(view, option, mappedFrom, mappedTo)
    expect(view.state.doc.toString()).toBe(`${PREFIX}詳細は [[release-plan|Release plan]]`)
    view.destroy()
  })

  it('closes once a # starts the fragment, so Enter finishes the line instead', () => {
    expect(complete('[[release-plan#', 15)).toBeNull()
    expect(complete('![[release-plan#Lau', 19)).toBeNull()
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

  it('writes the bare path when the name already equals it', () => {
    const doc = '[[sa'
    const result = complete(doc, doc.length)
    const index = result!.options.findIndex((o) => o.label === 'same')
    expect(accept(doc, result!, index)).toBe('[[same]]')
  })
})

describe('wikiLinkCompletionSource create row', () => {
  const created: string[][] = []
  const withCreate = (doc: string, ownPath?: string) =>
    wikiLinkCompletionSource(
      () => TARGETS,
      () => (path: string, name: string) => {
        created.push([path, name])
      },
      () => ownPath,
    )(new CompletionContext(EditorState.create({ doc }), doc.length, false))

  it('offers a Create row when the typed text matches no target', () => {
    const result = withCreate('[[Nope')
    expect(result?.options.map((o) => o.label)).toEqual(["Create 'Nope'"])
  })

  it('offers no Create row without a host that can create', () => {
    expect(complete('[[Nope', 6)).toBeNull()
  })

  it('offers no Create row for an empty query or an existing path', () => {
    expect(withCreate('[[')?.options.map((o) => o.label)).toEqual(TARGETS.map((t) => t.name))
    expect(withCreate('[[release-plan')).toBeNull()
  })

  it("offers no Create row for the open document's own path", () => {
    const source = wikiLinkCompletionSource(
      () => TARGETS,
      () => (path: string, name: string) => {
        created.push([path, name])
      },
      () => 'weekly-sync',
    )
    const doc = '[[weekly-sync'
    expect(source(new CompletionContext(EditorState.create({ doc }), doc.length, false))).toBeNull()
  })

  it('offers no Create row while any target matches the typed text', () => {
    const labels = withCreate('[[Re')?.options.map((o) => o.label)
    expect(labels?.[0]).toBe('Release plan')
    expect(labels?.some((l) => l.startsWith('Create'))).toBe(false)
  })

  it('accepting it creates the note under the derived address, named for the text, and writes the link to match', () => {
    created.length = 0
    const doc = 'See [[Lecture 6 notes'
    const result = withCreate(doc)
    expect(accept(doc, result!, 0)).toBe('See [[lecture-6-notes|Lecture 6 notes]]')
    expect(created).toEqual([['lecture-6-notes', 'Lecture 6 notes']])
  })

  it('makes the note beside the linking document', () => {
    created.length = 0
    const doc = '[[Glossary'
    const result = withCreate(doc, 'design/overview')
    expect(accept(doc, result!, 0)).toBe('[[design/glossary|Glossary]]')
    expect(created).toEqual([['design/glossary', 'Glossary']])
  })

  it('re-asks the source as the query grows so the row names the current text', () => {
    const result = withCreate('[[No')
    expect(typeof result?.validFor).toBe('function')
    const validFor = result?.validFor as (text: string) => boolean
    expect(validFor('No')).toBe(true)
    expect(validFor('Nop')).toBe(false)
  })
})
