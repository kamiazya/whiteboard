/**
 * An agent writes through MCP while a person watches the document list. The
 * daemon pushes the workspace record's update frame to every stream that
 * follows the workspace, with no document open, so the index has to read
 * again when one arrives — otherwise the README's "ask the agent to draw"
 * shows nothing until a reload, and reads as the agent having done nothing.
 */

import type {
  DocListener,
  SseStreamSource,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { workspaceDocKey } from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFakeDaemonFetch } from '../test-utils/fake-daemon-fetch.js'
import { DaemonIndexPage } from './DaemonIndexPage.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const BASE = 'http://127.0.0.1:3099'

/** A stream source that records who follows what, and delivers frames on demand. */
function fakeStream() {
  const listeners = new Map<string, Set<DocListener>>()
  const source: SseStreamSource = {
    subscribe(doc, listener) {
      listeners.set(doc, (listeners.get(doc) ?? new Set()).add(listener))
      return () => listeners.get(doc)?.delete(listener)
    },
    sendMessage: () => {},
    push: () => {},
    snapshot: async () => null,
  }
  return {
    source,
    followed: () => [...listeners].filter(([, set]) => set.size > 0).map(([doc]) => doc),
    deliver(doc: string) {
      for (const listener of listeners.get(doc) ?? []) listener.onUpdate(new Uint8Array([1]))
    },
  }
}

function mount(rows: { path: string }[], stream: SseStreamSource) {
  const documents = [...rows]
  installFakeDaemonFetch({
    workspaces: [{ workspaceId: 'ws-a' }],
    documentsByWorkspace: {
      'ws-a': () => documents.map((row) => ({ ...row, updatedAt: new Date().toISOString() })),
    },
  })
  render(
    <MemoryRouter>
      <DaemonIndexPage daemonBaseUrl={BASE} streamSource={stream} onOpenDocument={vi.fn()} />
    </MemoryRouter>,
  )
  return documents
}

describe('the daemon index follows an agent writing to its workspace', () => {
  it('lists a document written after it loaded, when the workspace update arrives', async () => {
    const stream = fakeStream()
    const documents = mount([{ path: 'alpha' }], stream.source)
    await screen.findByText('alpha')
    expect(stream.followed()).toEqual([workspaceDocKey('ws-a')])

    documents.push({ path: 'drawn-by-agent' })
    act(() => stream.deliver(workspaceDocKey('ws-a')))

    expect(await screen.findByText('drawn-by-agent')).toBeTruthy()
  })

  it('replaces the empty-workspace welcome with the list once something is written', async () => {
    const stream = fakeStream()
    const documents = mount([], stream.source)
    await screen.findByRole('button', { name: /canvas/i })

    documents.push({ path: 'first-drawing' })
    act(() => stream.deliver(workspaceDocKey('ws-a')))

    expect(await screen.findByText('first-drawing')).toBeTruthy()
  })

  it('stops following a workspace the page has left', async () => {
    const stream = fakeStream()
    mount([{ path: 'alpha' }], stream.source)
    await screen.findByText('alpha')

    cleanup()

    expect(stream.followed()).toEqual([])
  })
})
