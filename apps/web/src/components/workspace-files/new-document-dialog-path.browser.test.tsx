import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { addressForNameIn } from '../../lib/address-from-name.js'
import { NewDocumentMenu } from './NewDocumentMenu.js'

afterEach(cleanup)

const taken = ['design/untitled', 'design/q3-plan']

async function openDialog(onCreate = vi.fn()) {
  render(
    <NewDocumentMenu
      onCreate={onCreate}
      defaultPath="design/untitled-2"
      pathForName={(name, kind) => addressForNameIn('design', name, kind, taken)}
    />,
  )
  await page.getByRole('button', { name: 'New document' }).click()
  await page.getByTestId('new-document-specify').click()
  await expect.element(page.getByRole('dialog')).toBeVisible()
  return onCreate
}

describe('New document dialog path', () => {
  it('follows the typed name, numbered past a sibling, until the path is edited', async () => {
    const onCreate = await openDialog()
    const path = page.getByLabelText(/^Path/)

    await userEvent.click(page.getByLabelText(/^Name/))
    await userEvent.keyboard('Q3 Plan')
    await expect.element(path).toHaveValue('design/q3-plan-2')

    await userEvent.tripleClick(path)
    await userEvent.keyboard('plans/q3')
    await userEvent.click(page.getByLabelText(/^Name/))
    await userEvent.keyboard(' v2')
    await expect.element(path).toHaveValue('plans/q3')

    await page.getByRole('button', { name: 'Create' }).click()
    expect(onCreate).toHaveBeenCalledWith('spatial', { path: 'plans/q3', name: 'Q3 Plan v2' })
  })

  it('says the address rule is broken while the path is typed', async () => {
    const onCreate = await openDialog()
    const path = page.getByLabelText(/^Path/)
    await userEvent.tripleClick(path)
    await userEvent.keyboard('Meeting notes')

    await expect
      .element(page.getByText(/only letters a–z, digits and hyphens, with \/ between/))
      .toBeVisible()
    expect(onCreate).not.toHaveBeenCalled()
  })
})
