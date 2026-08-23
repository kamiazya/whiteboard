// The facet system's React half. A plugin owns how its facets are edited;
// this package holds what it builds that UI from, and the one path its
// writes take.
//
// Deliberately built on a synthetic plugin rather than the bundled one: the
// library must not know which plugins exist, and a test that reaches for
// `visual` cannot tell the two apart. (It also cannot import it — the
// bundled plugin depends on THIS package.)
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createFacetWriter, definePluginUi } from './index.js'

afterEach(cleanup)

const MARK_KEY = 'demo.mark/v0'

const registry = createFacetRegistry([
  definePlugin({
    id: 'demo',
    displayName: 'Demo',
    facets: [
      defineFacet({
        name: 'mark',
        displayName: 'Mark',
        version: 'v0',
        targets: ['node'],
        schema: z.object({ char: z.string().length(1) }),
      }),
    ],
  }),
])

describe('definePluginUi', () => {
  it('keeps the plugin’s own order, which the registry does not decide', () => {
    const ui = definePluginUi({
      plugin: 'demo',
      sections: [
        { title: 'Second', facet: 'b' },
        { title: 'First', facet: 'a' },
      ],
    })
    expect(ui.sections.map((s) => s.title)).toEqual(['Second', 'First'])
  })

  it('refuses two sections for one facet, which would render it twice', () => {
    expect(() =>
      definePluginUi({
        plugin: 'demo',
        sections: [
          { title: 'One', facet: 'mark' },
          { title: 'Again', facet: 'mark' },
        ],
      }),
    ).toThrow()
  })
})

describe('createFacetWriter', () => {
  it('is the only path to storage, and it validates', () => {
    const onWrite = vi.fn()
    const write = createFacetWriter(registry, MARK_KEY, onWrite)

    write({ char: 'x' })
    expect(onWrite).toHaveBeenCalledWith(MARK_KEY, { char: 'x' })

    // A plugin's own component gets no shorter route to storage than a
    // declared editor does.
    onWrite.mockClear()
    write({ char: 'far too long' })
    expect(onWrite).not.toHaveBeenCalled()
  })

  it('passes undefined through, because clearing is not a payload', () => {
    const onWrite = vi.fn()
    createFacetWriter(registry, MARK_KEY, onWrite)(undefined)
    expect(onWrite).toHaveBeenCalledWith(MARK_KEY, undefined)
  })
})

describe('a plugin-supplied component', () => {
  it('is rendered by the host with the value and the writer it was given', () => {
    const write = vi.fn()
    const ui = definePluginUi({
      plugin: 'demo',
      sections: [
        {
          title: 'Mark',
          facet: 'mark',
          component: ({ value }) => <span>{String((value as { char: string })?.char)}</span>,
        },
      ],
    })
    const Editor = ui.sections[0]?.component
    expect(Editor).toBeDefined()
    if (Editor === undefined) return
    render(<Editor value={{ char: 'q' }} write={write} />)
    expect(screen.getByText('q')).toBeTruthy()
  })
})
