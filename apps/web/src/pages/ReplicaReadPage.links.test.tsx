/**
 * A followed wiki link on the offline page opens its target in place, from
 * the replica record alone — the page's half of the link contract. The
 * preview is a double that hands the test the `onOpenDocument` the page gave
 * it; resolving and drawing the anchor is the markdown editor's to pin, and
 * the whole click path is `ReplicaReadPage.browser.test.tsx`'s.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinkTarget } from '../lib/link-target.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FB0'
const DOC_LINKER = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const DOC_PLAN = '01ARZ3NDEKTSV4RRFFQ69G5FB2'
const DOC_BOARD = '01ARZ3NDEKTSV4RRFFQ69G5FB3'
const UNKNOWN = '01ARZ3NDEKTSV4RRFFQ69G5FB9'

const store = vi.hoisted(() => ({
  record: null as import('loro-crdt').LoroDoc | null,
  onOpenDocument: undefined as ((documentId: string) => void) | undefined,
  linkTargets: undefined as readonly LinkTarget[] | undefined,
  canvasOpener: undefined as ((file: string) => void) | undefined,
}))

vi.mock('../lib/browser-workspace-docs.js', () => ({
  BrowserWorkspaceDocs: class {
    open = async () => store.record
    save = async () => {}
  },
}))

vi.mock('../components/markdown-editor/MarkdownEditor.js', () => ({
  MarkdownEditor: (props: {
    value: string
    onOpenDocument?: (documentId: string) => void
    linkTargets?: readonly LinkTarget[]
  }) => {
    store.onOpenDocument = props.onOpenDocument
    store.linkTargets = props.linkTargets
    return <div data-testid="markdown-editor">{props.value}</div>
  },
}))

vi.mock('../components/spatial-editor/SpatialEditor.js', () => ({
  SpatialEditor: (props: { onOpenDocument?: (file: string) => void }) => {
    store.canvasOpener = props.onOpenDocument
    return <div data-testid="spatial-editor" />
  },
}))

function seedRecord(): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: 'linker',
    documentId: DOC_LINKER,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(record, DOC_LINKER), 'see [[plan]]')
  createWorkspaceDocumentAtPath(record, { path: 'plan', documentId: DOC_PLAN, kind: 'markdown' })
  writeMarkdownBody(documentContainers(record, DOC_PLAN), 'the plan')
  createWorkspaceDocumentAtPath(record, { path: 'board', documentId: DOC_BOARD, kind: 'spatial' })
  record.commit()
  return record
}

async function openLinker(): Promise<void> {
  render(
    <ReplicaReadPage
      workspaceId={DAEMON_WS}
      daemonBaseUrl="http://127.0.0.1:3099"
      onReconnect={() => Promise.resolve()}
    />,
  )
  fireEvent.click(await screen.findByText('linker'))
  expect((await screen.findByTestId('markdown-editor')).textContent).toBe('see [[plan]]')
}

describe('ReplicaReadPage following a link', () => {
  afterEach(() => {
    cleanup()
    store.onOpenDocument = undefined
    store.linkTargets = undefined
    store.canvasOpener = undefined
  })

  it('opens the linked document from the replica in place', async () => {
    store.record = seedRecord()
    await openLinker()
    act(() => store.onOpenDocument?.(DOC_PLAN))
    expect((await screen.findByText('the plan')).dataset.testid).toBe('markdown-editor')
  })

  it('offers the link picker every other document, never the open one', async () => {
    store.record = seedRecord()
    await openLinker()
    expect(store.linkTargets?.map((target) => target.id)).toEqual([DOC_PLAN, DOC_BOARD])
  })

  it('opens nothing for an id the replica does not hold', async () => {
    store.record = seedRecord()
    await openLinker()
    expect(store.onOpenDocument).toBeTypeOf('function')
    act(() => store.onOpenDocument?.(UNKNOWN))
    expect(screen.getByTestId('markdown-editor').textContent).toBe('see [[plan]]')
  })

  describe('from a canvas', () => {
    async function openBoard(): Promise<void> {
      store.record = seedRecord()
      render(
        <ReplicaReadPage
          workspaceId={DAEMON_WS}
          daemonBaseUrl="http://127.0.0.1:3099"
          onReconnect={() => Promise.resolve()}
        />,
      )
      fireEvent.click(await screen.findByText('board'))
      await screen.findByTestId('spatial-editor')
      expect(store.canvasOpener).toBeTypeOf('function')
    }

    it('opens a document a node names by id', async () => {
      await openBoard()
      act(() => store.canvasOpener?.(DOC_PLAN))
      expect((await screen.findByText('the plan')).dataset.testid).toBe('markdown-editor')
    })

    it('opens a document a node names by path', async () => {
      await openBoard()
      act(() => store.canvasOpener?.('plan'))
      expect((await screen.findByText('the plan')).dataset.testid).toBe('markdown-editor')
    })

    it('opens nothing for a file the replica does not hold', async () => {
      await openBoard()
      act(() => store.canvasOpener?.('missing'))
      act(() => store.canvasOpener?.(UNKNOWN))
      expect(screen.getByTestId('spatial-editor')).toBeDefined()
    })
  })
})
