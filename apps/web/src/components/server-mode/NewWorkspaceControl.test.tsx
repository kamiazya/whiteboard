/**
 * NewWorkspaceControl's failure and keyboard behaviour. `ServerModeApp.test.tsx` states "the form stays,
 * with what was typed, so the person can retry" but never retries, and never presses Escape or Enter
 * during a composition, so each of those four behaviours can be deleted without a test noticing.
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeeperWorkspaces } from '../../lib/workspace-switcher-source.js'
import { NewWorkspaceControl } from './NewWorkspaceControl.js'

afterEach(cleanup)

function keeper(create: (name: string) => Promise<unknown>) {
  const onSwitch = vi.fn()
  const createSpy = vi.fn(create)
  const workspaces = { source: { create: createSpy }, onSwitch } as unknown as KeeperWorkspaces
  return { createSpy, onSwitch, workspaces }
}

async function openAndType(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'New workspace' }))
  const input = screen.getByLabelText('New workspace name') as HTMLInputElement
  fireEvent.change(input, { target: { value: name } })
  return input
}

describe('NewWorkspaceControl after a refused create', () => {
  it('can be retried: the second Create reaches the keeper again', async () => {
    const attempts = [new Error('keeper said no'), { workspaceId: 'ws-1', segment: 'plans' }]
    const { createSpy, onSwitch, workspaces } = keeper(async () => {
      const next = attempts.shift()
      if (next instanceof Error) throw next
      return next
    })
    render(<NewWorkspaceControl workspaces={workspaces} />)
    await openAndType('Plans')

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect((await screen.findByRole('alert')).textContent).toContain('keeper said no')

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1))
    expect(createSpy).toHaveBeenCalledTimes(2)
  })

  it('stops showing the old refusal while the retry is in flight', async () => {
    let call = 0
    const { workspaces } = keeper(() => {
      call += 1
      return call === 1 ? Promise.reject(new Error('keeper said no')) : new Promise(() => {})
    })
    render(<NewWorkspaceControl workspaces={workspaces} />)
    await openAndType('Plans')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('NewWorkspaceControl states', () => {
  it('offers nothing when the keeper has no create', () => {
    const { container } = render(
      <NewWorkspaceControl
        workspaces={{ source: {}, onSwitch: vi.fn() } as unknown as KeeperWorkspaces}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('Create is disabled while the name is blank and while a create is in flight', async () => {
    const { workspaces } = keeper(() => new Promise(() => {}))
    render(<NewWorkspaceControl workspaces={workspaces} />)
    const input = await openAndType('   ')
    const create = () => screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement
    expect(create().disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Plans' } })
    expect(create().disabled).toBe(false)
    fireEvent.click(create())
    await waitFor(() => expect(create().disabled).toBe(true))
  })

  it('marks the field invalid and points it at the refusal only once one was shown', async () => {
    const { workspaces } = keeper(() => Promise.reject(new Error('keeper said no')))
    render(<NewWorkspaceControl workspaces={workspaces} />)
    const input = await openAndType('Plans')
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(input.getAttribute('aria-describedby')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    const alert = await screen.findByRole('alert')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(alert.id)
  })
})

describe('NewWorkspaceControl keyboard', () => {
  it('Escape closes the form', async () => {
    const { workspaces } = keeper(() => new Promise(() => {}))
    render(<NewWorkspaceControl workspaces={workspaces} />)
    const input = await openAndType('Plans')

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByLabelText('New workspace name')).toBeNull()
    expect(screen.getByRole('button', { name: 'New workspace' })).toBeTruthy()
  })

  it('an Enter that confirms an IME conversion is held back; a plain Enter is not', async () => {
    const { workspaces } = keeper(() => new Promise(() => {}))
    render(<NewWorkspaceControl workspaces={workspaces} />)
    const input = await openAndType('にほん')

    // fireEvent answers false when the handler called preventDefault.
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false)
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false)
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true)
  })
})
