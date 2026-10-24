import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { setViewport } from '../../test-utils/viewport.js'
import { NewDocumentMenu } from './NewDocumentMenu.js'

afterEach(async () => {
  cleanup()
  await setViewport(1280, 800)
})

describe('New document sheet at phone width', () => {
  it('sits on the bottom edge with the name focused and creates by typing', async () => {
    await setViewport(375, 700)
    const onCreate = vi.fn()
    render(<NewDocumentMenu onCreate={onCreate} defaultPath="untitled" />)
    await page.getByRole('button', { name: 'New document' }).click()

    const sheet = page.getByTestId('new-document-sheet')
    await expect.element(sheet).toBeVisible()
    // Polled: the sheet's entrance animation is still settling at first paint.
    await expect
      .poll(() => Math.round(sheet.element().getBoundingClientRect().bottom))
      .toBe(window.innerHeight)

    await expect.element(page.getByLabelText(/^Name/)).toHaveFocus()
    await userEvent.keyboard('Plan')
    await userEvent.keyboard('{Enter}')
    expect(onCreate).toHaveBeenCalledWith('spatial', { path: 'untitled', name: 'Plan' })
  })
})
