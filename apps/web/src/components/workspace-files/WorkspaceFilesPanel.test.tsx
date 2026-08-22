// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceMissingError } from './files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

describe('WorkspaceFilesPanel list states', () => {
  // The pages map their own list failures before mounting the panel, so
  // these states are the panel's own defense — e.g. a workspace deleted by
  // an agent between the page's read and the panel's.
  it('shows a calm message, not an alert, when the workspace is missing', async () => {
    const source = fakeFilesSource({
      listDocuments: () => Promise.reject(new WorkspaceMissingError('gone')),
    })
    render(<WorkspaceFilesPanel source={source} />)

    await screen.findByText('This workspace has no document tree yet.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the alert for a non-missing failure', async () => {
    const source = fakeFilesSource({
      listDocuments: () => Promise.reject(new Error('boom')),
    })
    render(<WorkspaceFilesPanel source={source} />)

    await screen.findByRole('alert')
  })
})

describe('WorkspaceFilesPanel create guard', () => {
  // What stops the second press is the menu closing on select, NOT the
  // items' `disabled` — verified by removing that prop and watching this
  // stay green. It is pinned anyway because one gesture producing one
  // document is the contract; which layer delivers it may change.
  it('two same-tick selects of one kind send one create', async () => {
    let resolveCreate: (() => void) | undefined
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
      createDocument: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveCreate = resolve
          }),
      ),
    })
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New document' }), { button: 0 })
    const item = await screen.findByTestId('new-document-markdown')
    fireEvent.pointerUp(item)
    fireEvent.pointerUp(item)

    expect(source.createDocument).toHaveBeenCalledTimes(1)
    resolveCreate?.()
    await waitFor(() => expect(source.createDocument).toHaveBeenCalledTimes(1))
  })

  // The in-flight guard's real job: a create is resolving and the user
  // reopens the menu. `disabled` is what greys the kinds out there.
  it('offers no kind while a create is in flight', async () => {
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
      createDocument: vi.fn(() => new Promise<void>(() => {})),
    })
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    const trigger = screen.getByRole('button', { name: 'New document' })
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.pointerUp(await screen.findByTestId('new-document-markdown'))

    fireEvent.pointerDown(trigger, { button: 0 })
    await waitFor(() =>
      expect(
        screen.getByTestId('new-document-spatial').getAttribute('data-disabled'),
      ).not.toBeNull(),
    )
  })

  // The choice that fixes an unchangeable `kind` reaches the source intact.
  it('creates the kind the menu named', async () => {
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
    })
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New document' }), { button: 0 })
    fireEvent.pointerUp(await screen.findByTestId('new-document-spatial'))

    await waitFor(() =>
      expect(source.createDocument).toHaveBeenCalledWith('untitled', 'spatial', undefined),
    )
  })
})

describe('WorkspaceFilesPanel — name and location', () => {
  // The panel is what turns the dialog's answers into a create, so the seam
  // worth pinning is the source call: a name typed into the form has to
  // arrive in the SAME call that makes the document, not a follow-up.
  it('creates at the typed path with the typed name, in one call', async () => {
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
    })
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New document' }), { button: 0 })
    fireEvent.pointerUp(await screen.findByTestId('new-document-specify'))

    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Weekly notes' } })
    fireEvent.change(screen.getByLabelText(/^Path/), { target: { value: 'notes/weekly' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(source.createDocument).toHaveBeenCalledWith('notes/weekly', 'spatial', 'Weekly notes'),
    )
  })

  // Opening the form and submitting it untouched must be indistinguishable
  // from never opening it — otherwise the dialog is a second create flow
  // rather than the same one with the address shown.
  it('lands where the plain entry would have when the form is not edited', async () => {
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([
          { documentId: 'd1', path: 'untitled', kind: 'spatial' as const },
          { documentId: 'd2', path: 'untitled-2', kind: 'spatial' as const },
        ]),
    })
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New document' }), { button: 0 })
    fireEvent.pointerUp(await screen.findByTestId('new-document-specify'))
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(source.createDocument).toHaveBeenCalledWith('untitled-3', 'spatial', undefined),
    )
  })
})

describe('WorkspaceFilesPanel — creating opens what it made', () => {
  // Creation exists to produce content, and an empty document is worth
  // nothing until it is open — so the create ends where the next thing
  // happens. Four of the five creation paths already did this; the browser
  // was the one that left you looking at a card.
  //
  // It only became affordable once the open folder went into the address
  // (`initialFolder`/`onFolderChange`): before that, coming back landed you
  // at the workspace root, which costs more than being placed in the
  // document gains.
  it('opens the document it just created', async () => {
    const onOpenDocument = vi.fn()
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
    })
    render(<WorkspaceFilesPanel source={source} onOpenDocument={onOpenDocument} />)
    await screen.findAllByTestId('card-title')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New document' }), { button: 0 })
    fireEvent.pointerUp(await screen.findByTestId('new-document-spatial'))

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('untitled'))
  })

  // A create that failed has nothing to open, and navigating away would take
  // the error message with it.
  it('opens nothing when the create was refused', async () => {
    const onOpenDocument = vi.fn()
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
      createDocument: vi.fn(() => Promise.reject(new Error('refused'))),
    })
    render(<WorkspaceFilesPanel source={source} onOpenDocument={onOpenDocument} />)
    await screen.findAllByTestId('card-title')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New document' }), { button: 0 })
    fireEvent.pointerUp(await screen.findByTestId('new-document-spatial'))

    await screen.findByText(/Could not create/)
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  // Looking is still allowed: a host with no way to open a document must not
  // lose the ability to create one.
  it('still creates when the host offers no way to open', async () => {
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
    })
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New document' }), { button: 0 })
    fireEvent.pointerUp(await screen.findByTestId('new-document-spatial'))

    await waitFor(() => expect(source.createDocument).toHaveBeenCalled())
  })
})

describe('WorkspaceFilesPanel — a refused create is correctable', () => {
  // The panel already surfaces the server's own words for a failed MOVE, and
  // a create fails for the same reason a move does — the path is taken. The
  // dialog stays open holding what was typed, so the address can be fixed
  // where it was entered rather than re-typed from scratch.
  it('reports the source’s reason inside the dialog and leaves it open', async () => {
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
      createDocument: vi.fn(() => Promise.reject(new Error('"notes/weekly" already exists'))),
    })
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New document' }), { button: 0 })
    fireEvent.pointerUp(await screen.findByTestId('new-document-specify'))
    fireEvent.change(await screen.findByLabelText(/^Path/), { target: { value: 'notes/weekly' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('already exists')
    expect(screen.queryByRole('dialog')).not.toBeNull()
    // What was typed survives, which is the whole point of staying open.
    expect((screen.getByLabelText(/^Path/) as HTMLInputElement).value).toBe('notes/weekly')
  })
})
