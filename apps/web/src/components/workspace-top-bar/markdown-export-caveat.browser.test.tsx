/**
 * A note's Markdown save leaves its pictures and embedded diagrams out, and
 * says so twice: under the menu entry, where the choice is made, and in the
 * confirmation, only when the note held either. Real Chromium, and the
 * entry's description is read from Chromium's OWN accessibility tree: the
 * line is `aria-hidden` (kept out of the entry's name) and reaches a screen
 * reader only through `aria-describedby`, which is exactly the resolution a
 * DOM-level check would take on trust.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cdp, page, userEvent } from 'vitest/browser'
import '../../index.css'
import { DocumentMenu } from './DocumentMenu'
import { useSceneExport } from './useSceneExport'

interface AxNode {
  readonly role?: { readonly value?: string }
  readonly name?: { readonly value?: string }
  readonly description?: { readonly value?: string }
}

function NoteMenu({ body }: { body: string }) {
  const [notice, setNotice] = useState<string | null>(null)
  const { handleExport } = useSceneExport({
    onExport: async () => new Blob([body], { type: 'text/markdown' }),
    filenameBase: 'week-1',
    onExported: setNotice,
  })
  return (
    <DocumentMenu
      kind="markdown"
      notice={notice}
      onExport={(format) => {
        setNotice(null)
        void handleExport(format)
      }}
    />
  )
}

interface FrameTree {
  readonly frame: { readonly id: string; readonly url: string }
  readonly childFrames?: readonly FrameTree[]
}

/** Chromium's computed tree for every frame: the test renders inside the runner's iframe. */
async function accessibilityTree(): Promise<readonly AxNode[]> {
  const { frameTree } = (await cdp().send('Page.getFrameTree', {})) as { frameTree: FrameTree }
  const frames: string[] = []
  const walk = (tree: FrameTree) => {
    frames.push(tree.frame.id)
    for (const child of tree.childFrames ?? []) walk(child)
  }
  walk(frameTree)
  const trees = await Promise.all(
    frames.map(
      async (frameId) =>
        (
          (await cdp().send('Accessibility.getFullAXTree', { frameId })) as {
            nodes: readonly AxNode[]
          }
        ).nodes,
    ),
  )
  return trees.flat()
}

const SAVE = 'Save as Markdown (.md)'

async function openMarkdownSave(): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Export…' }).click()
  await screen.findByRole('menuitem', { name: SAVE })
}

async function saveMarkdown(body: string): Promise<string> {
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<NoteMenu body={body} />)
  await openMarkdownSave()
  await userEvent.click(screen.getByRole('menuitem', { name: SAVE }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Saved as/))
  return screen.getByRole('status').textContent ?? ''
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('saving a note as Markdown says what it leaves out', () => {
  it('describes the entry to a screen reader with the left-out line', async () => {
    render(<NoteMenu body="Plain text." />)
    await openMarkdownSave()
    const nodes = await accessibilityTree()
    const entries = nodes.filter(
      (node) => node.role?.value === 'menuitem' && node.name?.value === SAVE,
    )
    // The name stays the action alone; the caveat is its description.
    expect(entries).toHaveLength(1)
    expect(entries[0]?.description?.value).toMatch(
      /^Text only — pictures and embedded diagrams are not included\. For a handout, use Print \/ Save as PDF\.$/,
    )
  })

  it('announces the caveat after saving a note that holds a picture', async () => {
    expect(await saveMarkdown('# Week 1\n\n![diagram](asset:b2f6)\n')).toMatch(
      /pictures and embedded diagrams are not included/,
    )
  })

  it('announces the caveat after saving a note that embeds a board', async () => {
    expect(await saveMarkdown('See ![[water-cycle/diagram]]\n')).toMatch(
      /pictures and embedded diagrams are not included/,
    )
  })

  it('announces a plain confirmation for a note holding neither', async () => {
    expect(await saveMarkdown('[a link](x) and [[a note]]\n')).toBe('Saved as Markdown')
  })
})
