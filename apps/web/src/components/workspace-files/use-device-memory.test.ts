import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { RECENT_CAP } from '../../lib/recent-documents.js'
import { browserMemoryScope, daemonMemoryScope, useDeviceMemory } from './use-device-memory.js'

afterEach(() => localStorage.clear())

// Both keepers mint their first workspace under the segment `default`, so
// these two share a handle and differ in everything else.
const browserDefault = { workspaceId: '01JBROWSERWORKSPACE0000000', segment: 'default' }
const daemonDefault = { workspaceId: '01JDAEMONWORKSPACE00000000', segment: 'default' }
const DAEMON_URL = 'http://127.0.0.1:4410'

function entry(documentId: string, contentDigest?: string): WorkspaceDocumentEntry {
  return { documentId, path: documentId, ...(contentDigest === undefined ? {} : { contentDigest }) }
}

function mount(scope: string, documents: readonly WorkspaceDocumentEntry[] | null = null) {
  const hook = renderHook(() => useDeviceMemory(scope, documents))
  act(() => hook.result.current.reset())
  return hook
}

describe('device memory is kept per keeper and workspace id, not per address', () => {
  it('keeps a browser and a daemon workspace that share a segment apart', () => {
    const browser = mount(browserMemoryScope(browserDefault))
    act(() => browser.result.current.remember(entry('browser-doc')))
    browser.unmount()

    const daemon = mount(daemonMemoryScope(DAEMON_URL, daemonDefault))
    // A full lane in one keeper is exactly what used to evict the other's.
    for (let i = 0; i < RECENT_CAP; i++) {
      act(() => daemon.result.current.remember(entry(`daemon-doc-${i}`)))
    }
    daemon.unmount()

    expect(mount(browserMemoryScope(browserDefault)).result.current.recentIds).toEqual([
      'browser-doc',
    ])
  })

  it('keeps the lane and the seen baselines across a segment rename', () => {
    const before = mount(browserMemoryScope(browserDefault))
    act(() => before.result.current.remember(entry('doc', 'digest-1')))
    before.unmount()

    const renamed = { ...browserDefault, segment: 'notes' }
    const after = mount(browserMemoryScope(renamed), [entry('doc', 'digest-2')])

    expect(after.result.current.recentIds).toEqual(['doc'])
    expect([...(after.result.current.changed ?? [])]).toEqual(['doc'])
  })

  it('keeps two daemons apart even when their workspaces share an id', () => {
    const first = mount(daemonMemoryScope(DAEMON_URL, daemonDefault))
    act(() => first.result.current.remember(entry('first-daemon-doc')))
    first.unmount()

    const other = mount(daemonMemoryScope('http://127.0.0.1:4411', daemonDefault))
    expect(other.result.current.recentIds).toEqual([])
  })
})
