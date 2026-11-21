import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadCore } from './load.js'

/**
 * A markdown body through the shim over the built artifact: a comment is
 * sent only what its request reads, whatever a note on the same core left
 * behind (the fences' tokens it was answered) or the caller hands it (a
 * content cache, which only a note's boards keep bodies in).
 */

// Built, not committed: a name the relative-import scan reads as a file that
// must exist would fail every job that has no wasm build.
const WASM = 'whiteboard_wasm_bg.wasm'
const bytes = () => readFileSync(new URL(`../artifacts/${WASM}`, import.meta.url))

const measure = { kind: 'fake', factor: 0.6 } as const
const highlight = () => [[{ text: 'return 1', role: 'keyword' as const }]]

describe('a markdown body through the shim over the built artifact', () => {
  it('sends a comment none of the fence tokens a note left on the same core', async () => {
    const core = await loadCore(bytes())
    const note = core.layoutMarkdown(
      { kind: 'markdown', body: '```ts\nreturn 1\n```', maxWidth: 400, measure, mode: 'light' },
      highlight,
    )
    expect('scene' in note, JSON.stringify(note)).toBe(true)
    const comment = core.layoutMarkdown(
      { kind: 'comment', body: 'return 1', maxWidth: 200, measure, density: 'compact' },
      highlight,
    )
    expect('scene' in comment, JSON.stringify(comment)).toBe(true)
  })

  it('sends a comment no content cache, which only a note reads', async () => {
    const core = await loadCore(bytes())
    const request = { kind: 'comment', body: 'hi', maxWidth: 200, measure } as const
    const comment = core.layoutMarkdown(
      { ...request, density: 'comfortable' },
      undefined,
      undefined,
      {},
    )
    expect('scene' in comment, JSON.stringify(comment)).toBe(true)
    const note = core.layoutMarkdown(
      { kind: 'markdown', body: 'hi', maxWidth: 200, measure, mode: 'light' },
      undefined,
      undefined,
      {},
    )
    expect('scene' in note, JSON.stringify(note)).toBe(true)
  })

  it('answers the line each block of a note starts on', async () => {
    const core = await loadCore(bytes())
    const note = (body: string) =>
      core.layoutMarkdown({ kind: 'markdown', body, maxWidth: 400, measure, mode: 'light' })
    const laid = note('\n# One\r\n\r\ntext\n\n- a\n- b')
    expect('blockLines' in laid && laid.blockLines).toEqual([2, 4, 6])
    const empty = note('')
    expect('blockLines' in empty && empty.blockLines).toEqual([])
    const comment = core.layoutMarkdown({
      kind: 'comment',
      body: '# a\n\nb',
      maxWidth: 200,
      measure,
      density: 'compact',
    })
    expect('blockLines' in comment && comment.blockLines).toEqual([])
  })

  it.each([
    ['a note', { kind: 'markdown', mode: 'light' }],
    ['a comment', { kind: 'comment', density: 'compact' }],
  ] as const)('draws %s whose body holds a lone surrogate as it draws U+FFFD in its place', async (_name, shape) => {
    const core = await loadCore(bytes())
    const lay = (body: string) =>
      core.layoutMarkdown({ ...shape, body, maxWidth: 400, measure } as never)

    const drawn = lay('before \ud800 after')

    expect('scene' in drawn, JSON.stringify(drawn)).toBe(true)
    expect(drawn).toEqual(lay('before \ufffd after'))
  })
})
