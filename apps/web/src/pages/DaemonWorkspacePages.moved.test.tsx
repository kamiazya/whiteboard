/**
 * A document that moved to its name's path keeps its mount and gets the new
 * address by replace, so the editor does not reload and Back does not return
 * to the generated path.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWorkspaceRoute } from '../lib/app-routes.js'
import { useRecordPushes } from '../test-utils/record-pushes.js'
import { DaemonWorkspacePages } from './DaemonWorkspacePages.js'

const mounts = vi.hoisted(() => ({ count: 0 }))

vi.mock('./DaemonDocumentPage.js', async () => {
  const { useEffect: useMountEffect } = await import('react')
  return {
    DaemonDocumentPage: ({
      path,
      onPathMoved,
    }: {
      path?: string
      onPathMoved?: (path: string) => void
    }) => {
      useMountEffect(() => {
        mounts.count++
      }, [])
      return (
        <button type="button" onClick={() => onPathMoved?.('checkout-architecture')}>
          {`at ${path}`}
        </button>
      )
    },
  }
})

afterEach(() => {
  cleanup()
  mounts.count = 0
})

const pushed: string[] = []

function Host() {
  const location = useLocation()
  useRecordPushes(pushed)
  const view = parseWorkspaceRoute(location.pathname)
  if (view === null) return null
  return (
    <>
      <output data-testid="address">{location.pathname}</output>
      <DaemonWorkspacePages
        daemonBaseUrl="http://127.0.0.1:3099"
        view={view}
        onView={() => {}}
        waitingMessage="waiting"
      />
    </>
  )
}

describe('DaemonWorkspacePages document moved', () => {
  it('points the address at the new path by replace and keeps the mount', async () => {
    pushed.length = 0
    render(
      <MemoryRouter initialEntries={['/w/w1/d/untitled']}>
        <Host />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'at untitled' }))

    expect((await screen.findByTestId('address')).textContent).toBe('/w/w1/d/checkout-architecture')
    expect(await screen.findByRole('button', { name: 'at checkout-architecture' })).toBeTruthy()
    expect(pushed).toEqual([])
    expect(mounts.count).toBe(1)
  })
})
