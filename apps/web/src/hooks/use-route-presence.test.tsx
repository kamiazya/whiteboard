import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { announceRoute, routeAnnouncementSnapshot } from '../lib/route-announcer.js'
import { useDocumentRoutePresence } from './use-route-presence.js'

afterEach(() => {
  cleanup()
  announceRoute('')
})

const EMPTY_CANVAS: SpatialCanvas = { nodes: [], edges: [] }

function model(srTitle: string) {
  return {
    scopeKey: 'doc-1',
    srTitle,
    markdown: { hydrating: false, body: 'x' },
    sync: { loaded: true, canvas: EMPTY_CANVAS },
  } as const
}

describe('document arrival announcement', () => {
  it('follows the name when it resolves after arrival', () => {
    const { rerender } = renderHook(
      ({ title }) => useDocumentRoutePresence(model(title), 'markdown'),
      {
        initialProps: { title: 'Untitled' },
      },
    )
    expect(routeAnnouncementSnapshot()).toBe('Untitled, markdown note')
    rerender({ title: 'Lecture 6 notes' })
    expect(routeAnnouncementSnapshot()).toBe('Lecture 6 notes, markdown note')
  })

  it('leaves a later message, such as a rename receipt, alone when the name settles', () => {
    const { rerender } = renderHook(
      ({ title }) => useDocumentRoutePresence(model(title), 'markdown'),
      {
        initialProps: { title: 'Untitled' },
      },
    )
    act(() => announceRoute('Renamed to Lecture 6 notes'))
    rerender({ title: 'Lecture 6 notes' })
    expect(routeAnnouncementSnapshot()).toBe('Renamed to Lecture 6 notes')
  })
})
