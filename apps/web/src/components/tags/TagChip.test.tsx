// @vitest-environment jsdom
// The chip menu (ADR-0040 decision 5's declared layer): a scoped tag on a
// surface that can write the tag library offers a colour, and says so politely.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TagChipsEditor } from './TagChipsEditor.js'
import { TagColouringProvider } from './tag-colouring.js'

afterEach(cleanup)

async function openChipMenu(tag: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Tag ${tag} menu` }), {
    button: 0,
    ctrlKey: false,
  })
  return screen.findByRole('menu')
}

const choose = (name: string) => {
  const item = screen.getByRole('menuitem', { name })
  fireEvent.pointerUp(item)
}

function renderEditor(setTagColour: ((tag: string, colour: never) => Promise<void>) | undefined) {
  return render(
    <TagColouringProvider setTagColour={setTagColour as never}>
      <TagChipsEditor tags={['kind:service', 'draft']} onChange={vi.fn()} />
    </TagColouringProvider>,
    { container: document.body },
  )
}

describe('a tag chip menu', () => {
  it('colours a key:value tag from "Set colour…" and announces it', async () => {
    const setTagColour = vi.fn().mockResolvedValue(undefined)
    renderEditor(setTagColour)
    await openChipMenu('kind:service')
    choose('Set colour…')
    await screen.findByRole('menuitem', { name: 'No colour' })
    choose('Cyan')
    expect(setTagColour).toHaveBeenCalledWith('kind:service', '5')
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe("Tag 'kind:service' coloured cyan"),
    )
  })

  it('clears the colour with "No colour"', async () => {
    const setTagColour = vi.fn().mockResolvedValue(undefined)
    renderEditor(setTagColour)
    await openChipMenu('kind:service')
    choose('Set colour…')
    await screen.findByRole('menuitem', { name: 'No colour' })
    choose('No colour')
    expect(setTagColour).toHaveBeenCalledWith('kind:service', undefined)
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe("Tag 'kind:service' colour removed"),
    )
  })

  it('gives a plain tag no menu, since the library colours key:value tags only', () => {
    renderEditor(vi.fn())
    expect(screen.queryByRole('button', { name: 'Tag draft menu' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Tag kind:service menu' })).not.toBeNull()
  })

  it('offers no menu and no legend hint where the library cannot be written', () => {
    renderEditor(undefined)
    expect(screen.queryByRole('button', { name: /menu$/ })).toBeNull()
    expect(screen.queryByText(/appears in the legend/)).toBeNull()
  })

  it('hints the key:value form and the legend where it can be written', () => {
    renderEditor(vi.fn())
    expect(screen.getByLabelText('Add tag').getAttribute('placeholder')).toContain('kind:service')
    expect(screen.getByText(/appears in the legend/)).not.toBeNull()
  })

  it('says why when the library write fails, and announces nothing', async () => {
    renderEditor(vi.fn().mockRejectedValue(new Error('quota')))
    await openChipMenu('kind:service')
    choose('Set colour…')
    await screen.findByRole('menuitem', { name: 'No colour' })
    choose('Red')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('quota'))
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
