import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import type { LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it, vi } from 'vitest'
import { shortcodeCompletionSource, shortcodeOptionRenderers } from './shortcode-completion.js'

// The realm's core, which one case swaps for a core that refuses everything,
// as the page's is after a load that failed.
const realm = vi.hoisted(() => ({ refusing: false }))
vi.mock('../../lib/spatial/require-layout-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/spatial/require-layout-core.js')>()
  return {
    requireLayoutCore: (): LayoutCore => {
      const core = actual.requireLayoutCore()
      if (!realm.refusing) return core
      return {
        ...core,
        markdown: {
          layoutMarkdown: () => ({ refused: { code: 'malformed', reason: 'core-unavailable' } }),
        },
      }
    },
  }
})

async function starRow() {
  const doc = ':icon-st'
  const ctx = new CompletionContext(EditorState.create({ doc }), doc.length, true)
  const row = (await shortcodeCompletionSource(ctx))?.options.find((o) => o.label === 'icon-star')
  if (row === undefined) throw new Error('expected the icon-star row')
  return row
}

describe('a row glyph the core could not draw', () => {
  it('is asked for again once the core answers, not kept empty', async () => {
    const [renderer] = shortcodeOptionRenderers
    if (renderer === undefined) throw new Error('expected the glyph renderer')
    const row = await starRow()
    realm.refusing = true
    expect((renderer.render(row) as HTMLElement).querySelector('svg')).toBeNull()
    realm.refusing = false
    const drawn = renderer.render(row) as HTMLElement
    expect(drawn.querySelector('use')?.getAttribute('href')).toBe('#wb-icon-star')
  })
})
